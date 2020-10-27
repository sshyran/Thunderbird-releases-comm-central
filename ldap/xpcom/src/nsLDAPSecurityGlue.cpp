/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Only build this code if PSM is being built also
//
#include "nsLDAPInternal.h"
#include "nsCOMPtr.h"
#include "nsIServiceManager.h"
#include "nsIInterfaceRequestor.h"
#include "nsISocketProviderService.h"
#include "nsSocketProviderService.h"
#include "nsISocketProvider.h"
#include "nsISSLSocketControl.h"
#include "nsString.h"
#include "nsMemory.h"
#include "plstr.h"
#include "ldap.h"
#include "ldappr.h"
#include "nsComponentManagerUtils.h"
#include "nsServiceManagerUtils.h"

// LDAP per-session data structure.
//
typedef struct {
  char* hostname;
  LDAP_X_EXTIOF_CLOSE_CALLBACK* realClose;
  LDAP_X_EXTIOF_CONNECT_CALLBACK* realConnect;
  LDAP_X_EXTIOF_DISPOSEHANDLE_CALLBACK* realDisposeHandle;
} nsLDAPSSLSessionClosure;

// LDAP per-socket data structure.
//
struct nsLDAPSSLSocketClosure {
  nsLDAPSSLSocketClosure() : sessionClosure(nullptr), securityInfo(nullptr) {}
  nsLDAPSSLSessionClosure* sessionClosure; /* session info */
  nsCOMPtr<nsISupports> securityInfo;
};

// Replacement close() function, which cleans up local stuff associated
// with this socket, and then calls the real close function.
//
extern "C" int LDAP_CALLBACK
nsLDAPSSLClose(int s, struct lextiof_socket_private* socketarg) {
  PRLDAPSocketInfo socketInfo;

  // get the socketInfo associated with this socket
  //
  memset(&socketInfo, 0, sizeof(socketInfo));
  socketInfo.soinfo_size = PRLDAP_SOCKETINFO_SIZE;
  if (prldap_get_socket_info(s, socketarg, &socketInfo) != LDAP_SUCCESS) {
    NS_ERROR("nsLDAPSSLClose(): prldap_get_socket_info() failed");
    return -1;
  }

  // save off the session closure data in an automatic, since we're going to
  // need to call through it
  //
  nsLDAPSSLSocketClosure* socketClosure =
      reinterpret_cast<nsLDAPSSLSocketClosure*>(socketInfo.soinfo_appdata);
  if (!socketClosure) {
    NS_ERROR("nsLDAPSSLClose(): no socketClosure to be had");
    return -1;
  }

  // call the real close function
  nsLDAPSSLSessionClosure* sessionClosure = socketClosure->sessionClosure;
  int ret = (*(sessionClosure->realClose))(s, socketarg);

  delete socketClosure;
  return ret;
}

// Replacement connection function.  Calls the real connect function,
//
extern "C" int LDAP_CALLBACK nsLDAPSSLConnect(
    const char* hostlist, int defport, int timeout, unsigned long options,
    struct lextiof_session_private* sessionarg,
    struct lextiof_socket_private** socketargp) {
  PRLDAPSocketInfo socketInfo;
  PRLDAPSessionInfo sessionInfo;
  nsLDAPSSLSocketClosure* socketClosure = nullptr;
  nsLDAPSSLSessionClosure* sessionClosure;
  int intfd = -1;
  nsCOMPtr<nsISupports> securityInfo;
  nsCOMPtr<nsISocketProvider> tlsSocketProvider;
  nsCOMPtr<nsISSLSocketControl> sslSocketControl;
  nsCOMPtr<nsISocketProviderService> sps;
  nsresult rv;

  // Ensure secure option is set.  Also, clear secure bit in options
  // the we pass to the standard connect() function (since it doesn't know
  // how to handle the secure option).
  //
  NS_ASSERTION(options & LDAP_X_EXTIOF_OPT_SECURE,
               "nsLDAPSSLConnect(): called for non-secure connection");
  options &= ~LDAP_X_EXTIOF_OPT_SECURE;

  NS_ASSERTION(options & LDAP_X_EXTIOF_OPT_NONBLOCKING,
               "nsLDAPSSLConnect(): called for blocking connection");
  // Retrieve session info. so we can store a pointer to our session info.
  // in our socket info. later.
  //
  memset(&sessionInfo, 0, sizeof(sessionInfo));
  sessionInfo.seinfo_size = PRLDAP_SESSIONINFO_SIZE;
  if (prldap_get_session_info(nullptr, sessionarg, &sessionInfo) !=
      LDAP_SUCCESS) {
    NS_ERROR("nsLDAPSSLConnect(): unable to get session info");
    return -1;
  }
  sessionClosure =
      reinterpret_cast<nsLDAPSSLSessionClosure*>(sessionInfo.seinfo_appdata);

  // Call the real connect() callback to make the TCP connection.  If it
  // succeeds, *socketargp is set.
  //
  intfd = (*(sessionClosure->realConnect))(hostlist, defport, timeout, options,
                                           sessionarg, socketargp);
  if (intfd < 0) {
    MOZ_LOG(
        gLDAPLogModule, mozilla::LogLevel::Debug,
        ("nsLDAPSSLConnect(): standard connect() function returned %d", intfd));
    return intfd;
  }

  // Retrieve socket info from the newly created socket so that we
  // have the PRFileDesc onto which we will be layering SSL.
  //
  memset(&socketInfo, 0, sizeof(socketInfo));
  socketInfo.soinfo_size = PRLDAP_SOCKETINFO_SIZE;
  if (prldap_get_socket_info(intfd, *socketargp, &socketInfo) != LDAP_SUCCESS) {
    NS_ERROR("nsLDAPSSLConnect(): unable to get socket info");
    goto close_socket_and_exit_with_error;
  }

  // Allocate a structure to hold our socket-specific data.
  socketClosure = new nsLDAPSSLSocketClosure;
  socketClosure->sessionClosure = sessionClosure;
  socketClosure->securityInfo = nullptr;

  // Add the NSPR layer for SSL provided by PSM to this socket.
  sps = nsSocketProviderService::GetOrCreate();
  if (!sps || NS_FAILED(sps->GetSocketProvider(
                  "starttls", getter_AddRefs(tlsSocketProvider)))) {
    NS_ERROR("nsLDAPSSLConnect(): unable to get starttls socket provider");
    goto close_socket_and_exit_with_error;
  }

  // XXXdmose: Note that hostlist can be a list of hosts (in the
  // current XPCOM SDK code, it will always be a list of IP
  // addresses).  Because of this, we need to use
  // sessionClosure->hostname which was passed in separately to tell
  // AddToSocket what to match the name in the certificate against.
  // What exactly happen will happen when this is used with some IP
  // address in the list other than the first one is not entirely
  // clear, and I suspect it may depend on the format of the name in
  // the certificate.  Need to investigate.
  //
  rv = tlsSocketProvider->AddToSocket(
      PR_AF_INET, sessionClosure->hostname, defport, nullptr,
      mozilla::OriginAttributes(), 0, 0, socketInfo.soinfo_prfd,
      getter_AddRefs(securityInfo));
  if (NS_FAILED(rv)) {
    NS_ERROR("nsLDAPSSLConnect(): unable to add SSL layer to socket");
    goto close_socket_and_exit_with_error;
  }

  // If possible we want to avoid using SSLv2, as this can confuse
  // some directory servers (notably the netscape 4.1 ds).  The only
  // way that PSM provides for us to do this is to use a socket that can
  // be used for the STARTTLS protocol, because the STARTTLS protocol disallows
  // the use of SSLv2.
  // (Thanks to Brian Ryner for helping figure this out).
  //
  sslSocketControl = do_QueryInterface(securityInfo, &rv);
  if (NS_FAILED(rv)) {
    NS_WARNING("nsLDAPSSLConnect(): unable to QI to nsISSLSocketControl");
  } else {
    rv = sslSocketControl->StartTLS();
    if (NS_FAILED(rv)) {
      NS_WARNING("nsLDAPSSLConnect(): StartTLS failed");
    }
  }

  // Attach our closure to the socketInfo, making sure to stash the
  // securityInfo so we can get at it later during error handling.
  socketClosure->securityInfo = securityInfo;
  socketInfo.soinfo_appdata =
      reinterpret_cast<prldap_socket_private*>(socketClosure);
  if (prldap_set_socket_info(intfd, *socketargp, &socketInfo) != LDAP_SUCCESS) {
    NS_ERROR("nsLDAPSSLConnect(): unable to set socket info");
  }
  return intfd;  // success

close_socket_and_exit_with_error:
  if (socketInfo.soinfo_prfd) {
    PR_Close(socketInfo.soinfo_prfd);
  }
  if (socketClosure) {
    delete socketClosure;
  }
  if (intfd >= 0 && *socketargp) {
    (*(sessionClosure->realClose))(intfd, *socketargp);
  }
  return -1;
}

// Free data associated with this session (LDAP *) as necessary.
//
static void nsLDAPSSLFreeSessionClosure(
    nsLDAPSSLSessionClosure** aSessionClosure) {
  if (aSessionClosure && *aSessionClosure) {
    // free the hostname
    //
    if ((*aSessionClosure)->hostname) {
      PL_strfree((*aSessionClosure)->hostname);
      (*aSessionClosure)->hostname = nullptr;
    }

    // free the structure itself
    //
    free(*aSessionClosure);
    *aSessionClosure = nullptr;
  }
}

// Replacement session handle disposal code.  First cleans up our local
// stuff, then calls the original session handle disposal function.
//
extern "C" void LDAP_CALLBACK
nsLDAPSSLDisposeHandle(LDAP* ld, struct lextiof_session_private* sessionarg) {
  PRLDAPSessionInfo sessionInfo;
  nsLDAPSSLSessionClosure* sessionClosure;
  LDAP_X_EXTIOF_DISPOSEHANDLE_CALLBACK* disposehdl_fn;

  memset(&sessionInfo, 0, sizeof(sessionInfo));
  sessionInfo.seinfo_size = PRLDAP_SESSIONINFO_SIZE;
  if (prldap_get_session_info(ld, nullptr, &sessionInfo) == LDAP_SUCCESS) {
    sessionClosure =
        reinterpret_cast<nsLDAPSSLSessionClosure*>(sessionInfo.seinfo_appdata);
    disposehdl_fn = sessionClosure->realDisposeHandle;
    nsLDAPSSLFreeSessionClosure(&sessionClosure);
    (*disposehdl_fn)(ld, sessionarg);
  }
}

// Installs appropriate routines and data for making this connection
// handle SSL.  The aHostName is ultimately passed to PSM and is used to
// validate certificates.
//
nsresult nsLDAPInstallSSL(LDAP* ld, const char* aHostName) {
  struct ldap_x_ext_io_fns iofns;
  nsLDAPSSLSessionClosure* sessionClosure;
  PRLDAPSessionInfo sessionInfo;

  // Allocate our own session information.
  //
  sessionClosure = static_cast<nsLDAPSSLSessionClosure*>(
      moz_xmalloc(sizeof(nsLDAPSSLSessionClosure)));
  if (!sessionClosure) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  memset(sessionClosure, 0, sizeof(nsLDAPSSLSessionClosure));

  // Override a few functions, saving a pointer to the original function
  // in each case so we can call it from our SSL savvy functions.
  //
  memset(&iofns, 0, sizeof(iofns));
  iofns.lextiof_size = LDAP_X_EXTIO_FNS_SIZE;
  if (ldap_get_option(ld, LDAP_X_OPT_EXTIO_FN_PTRS,
                      static_cast<void*>(&iofns)) != LDAP_SUCCESS) {
    NS_ERROR(
        "nsLDAPInstallSSL(): unexpected error getting"
        " LDAP_X_OPT_EXTIO_FN_PTRS");
    nsLDAPSSLFreeSessionClosure(&sessionClosure);
    return NS_ERROR_UNEXPECTED;
  }

  // Make a copy of the hostname to pass to AddToSocket later
  //
  sessionClosure->hostname = PL_strdup(aHostName);
  if (!sessionClosure->hostname) {
    NS_ERROR("nsLDAPInstallSSL(): PL_strdup failed");
    nsLDAPSSLFreeSessionClosure(&sessionClosure);
    return NS_ERROR_OUT_OF_MEMORY;
  }

  // Override functions
  //
  sessionClosure->realClose = iofns.lextiof_close;
  iofns.lextiof_close = nsLDAPSSLClose;
  sessionClosure->realConnect = iofns.lextiof_connect;
  iofns.lextiof_connect = nsLDAPSSLConnect;
  sessionClosure->realDisposeHandle = iofns.lextiof_disposehandle;
  iofns.lextiof_disposehandle = nsLDAPSSLDisposeHandle;

  if (ldap_set_option(ld, LDAP_X_OPT_EXTIO_FN_PTRS,
                      static_cast<void*>(&iofns)) != LDAP_SUCCESS) {
    NS_ERROR("nsLDAPInstallSSL(): error setting LDAP_X_OPT_EXTIO_FN_PTRS");
    nsLDAPSSLFreeSessionClosure(&sessionClosure);
    return NS_ERROR_FAILURE;
  }

  // Store session info. for later retrieval.
  //
  sessionInfo.seinfo_size = PRLDAP_SESSIONINFO_SIZE;
  sessionInfo.seinfo_appdata =
      reinterpret_cast<prldap_session_private*>(sessionClosure);
  if (prldap_set_session_info(ld, nullptr, &sessionInfo) != LDAP_SUCCESS) {
    NS_ERROR("nsLDAPInstallSSL(): error setting prldap session info");
    free(sessionClosure);
    return NS_ERROR_UNEXPECTED;
  }

  return NS_OK;
}

// Fetch the securityInfo associated with a secure ldap connection.
// Fails if no securityInfo is found (e.g. if called on an ldap connection
// which wasn't augmented with nsLDAPInstallSSL()).
nsresult nsLDAPGetSecInfo(LDAP* ld, nsISupports** secInfo) {
  NS_ENSURE_ARG_POINTER(secInfo);

  PRLDAPSocketInfo soinfo;
  soinfo.soinfo_size = PRLDAP_SOCKETINFO_SIZE;
  int code = prldap_get_default_socket_info(ld, &soinfo);
  if (code != LDAP_SUCCESS) {
    return NS_ERROR_FAILURE;
  }
  nsLDAPSSLSocketClosure* socketClosure =
      reinterpret_cast<nsLDAPSSLSocketClosure*>(soinfo.soinfo_appdata);
  if (!socketClosure) {
    return NS_ERROR_FAILURE;
  }
  NS_IF_ADDREF(*secInfo = socketClosure->securityInfo);
  return NS_OK;
}
