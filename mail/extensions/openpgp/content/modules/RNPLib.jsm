/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const EXPORTED_SYMBOLS = ["RNPLibLoader"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

XPCOMUtils.defineLazyModuleGetters(this, {
  EnigmailApp: "chrome://openpgp/content/modules/app.jsm",
  EnigmailCryptoAPI: "chrome://openpgp/content/modules/cryptoAPI.jsm",
  ctypes: "resource://gre/modules/ctypes.jsm",
  OpenPGPMasterpass: "chrome://openpgp/content/modules/masterpass.jsm",
  OS: "resource://gre/modules/osfile.jsm",
  Services: "resource://gre/modules/Services.jsm",
});

var systemOS = Services.appinfo.OS.toLowerCase();
var abi = ctypes.default_abi;

// Open librnp. Determine the path to the chrome directory and look for it
// there first. If not, fallback to searching the standard locations.
var librnp, librnpPath;

function tryLoadRNP(name, suffix) {
  let filename = ctypes.libraryName(name) + suffix;
  let binPath = Services.dirsvc.get("XpcomLib", Ci.nsIFile).path;
  let binDir = OS.Path.dirname(binPath);
  librnpPath = OS.Path.join(binDir, filename);

  let loadFromInfo;

  try {
    loadFromInfo = librnpPath;
    librnp = ctypes.open(librnpPath);
  } catch (e) {}

  if (!librnp) {
    try {
      loadFromInfo = "system's standard library locations";
      // look in standard locations
      librnpPath = filename;
      librnp = ctypes.open(librnpPath);
    } catch (e) {}
  }

  if (librnp) {
    console.debug(
      "Successfully loaded OpenPGP library " +
        filename +
        " from " +
        loadFromInfo
    );
  }
}

function loadExternalRNPLib() {
  if (!librnp) {
    // Try loading librnp.so, librnp.dylib, or rnp.dll first
    tryLoadRNP("rnp", "");
  }

  if (!librnp && (systemOS === "winnt" || systemOS === "darwin")) {
    // rnp.0.dll or rnp.0.dylib
    tryLoadRNP("rnp.0", "");
  }

  if (!librnp) {
    tryLoadRNP("rnp-0", "");
  }

  if (!librnp && systemOS === "winnt") {
    // librnp-0.dll
    tryLoadRNP("librnp-0", "");
  }

  if (!librnp && !(systemOS === "winnt") && !(systemOS === "darwin")) {
    // librnp.so.0
    tryLoadRNP("rnp", ".0");
  }

  if (!librnp) {
    throw new Error("Cannot load required RNP library");
  }
}

var RNPLibLoader = {
  init() {
    loadExternalRNPLib();
    if (librnp) {
      enableRNPLibJS();
    }
    return RNPLib;
  },
};

const rnp_result_t = ctypes.uint32_t;
const rnp_ffi_t = ctypes.void_t.ptr;
const rnp_input_t = ctypes.void_t.ptr;
const rnp_output_t = ctypes.void_t.ptr;
const rnp_key_handle_t = ctypes.void_t.ptr;
const rnp_uid_handle_t = ctypes.void_t.ptr;
const rnp_identifier_iterator_t = ctypes.void_t.ptr;
const rnp_op_generate_t = ctypes.void_t.ptr;
const rnp_op_encrypt_t = ctypes.void_t.ptr;
const rnp_op_sign_t = ctypes.void_t.ptr;
const rnp_op_sign_signature_t = ctypes.void_t.ptr;
const rnp_op_verify_t = ctypes.void_t.ptr;
const rnp_op_verify_signature_t = ctypes.void_t.ptr;
const rnp_signature_handle_t = ctypes.void_t.ptr;
const rnp_recipient_handle_t = ctypes.void_t.ptr;
const rnp_symenc_handle_t = ctypes.void_t.ptr;

const rnp_password_cb_t = ctypes.FunctionType(abi, ctypes.bool, [
  rnp_ffi_t,
  ctypes.void_t.ptr,
  rnp_key_handle_t,
  ctypes.char.ptr,
  ctypes.char.ptr,
  ctypes.size_t,
]).ptr;

var RNPLib;

function enableRNPLibJS() {
  // this must be delayed until after "librnp" is initialized

  RNPLib = {
    path: librnpPath,

    ffi: null,

    // returns rnp_input_t, destroy using rnp_input_destroy
    async createInputFromPath(path) {
      // OS.File.read always returns an array.
      let u8 = await OS.File.read(path);
      if (!u8.length) {
        return null;
      }

      let input_from_memory = new this.rnp_input_t();
      try {
        this.rnp_input_from_memory(
          input_from_memory.address(),
          u8,
          u8.length,
          false
        );
      } catch (ex) {
        throw new Error("rnp_input_from_memory for file " + path + " failed");
      }
      return input_from_memory;
    },

    getFilenames() {
      let names = {};

      let secFile = EnigmailApp.getProfileDirectory();
      secFile.append("secring.gpg");
      let pubFile = EnigmailApp.getProfileDirectory();
      pubFile.append("pubring.gpg");

      names.secring = secFile.clone();
      names.pubring = pubFile.clone();

      return names;
    },

    /**
     * Load a keyring file into the global ffi context.
     *
     * @param {string} filename - The file to load
     * @param keyringFlag - either RNP_LOAD_SAVE_PUBLIC_KEYS
     *                      or RNP_LOAD_SAVE_SECRET_KEYS
     */
    async loadFile(filename, keyringFlag) {
      let in_file = await this.createInputFromPath(filename);
      if (in_file) {
        this.rnp_load_keys(this.ffi, "GPG", in_file, keyringFlag);
        this.rnp_input_destroy(in_file);
      }
    },

    /**
     * Load a keyring file into the global ffi context.
     * If the file couldn't be opened, fall back to a backup file,
     * by appending ".old" to filename.
     *
     * @param {string} filename - The file to load
     * @param keyringFlag - either RNP_LOAD_SAVE_PUBLIC_KEYS
     *                      or RNP_LOAD_SAVE_SECRET_KEYS
     */
    async loadWithFallback(filename, keyringFlag) {
      let loadBackup = false;
      try {
        await this.loadFile(filename, keyringFlag);
      } catch (ex) {
        if (ex instanceof OS.File.Error) {
          loadBackup = true;
        }
      }
      if (loadBackup) {
        filename += ".old";
        try {
          await this.loadFile(filename, keyringFlag);
        } catch (ex) {}
      }
    },

    async init() {
      this.ffi = new rnp_ffi_t();
      if (this.rnp_ffi_create(this.ffi.address(), "GPG", "GPG")) {
        throw new Error("Couldn't initialize librnp.");
      }

      this.rnp_ffi_set_log_fd(this.ffi, 2); // stderr

      this.keep_password_cb_alive = rnp_password_cb_t(
        this.password_cb,
        this, // this value used while executing callback
        false // callback return value if exception is thrown
      );
      this.rnp_ffi_set_pass_provider(
        this.ffi,
        this.keep_password_cb_alive,
        null
      );

      let filenames = this.getFilenames();

      await this.loadWithFallback(
        filenames.pubring.path,
        this.RNP_LOAD_SAVE_PUBLIC_KEYS
      );
      await this.loadWithFallback(
        filenames.secring.path,
        this.RNP_LOAD_SAVE_SECRET_KEYS
      );

      let pubnum = new ctypes.size_t();
      this.rnp_get_public_key_count(this.ffi, pubnum.address());

      let secnum = new ctypes.size_t();
      this.rnp_get_secret_key_count(this.ffi, secnum.address());

      console.debug(
        "public keys: " + pubnum.value + ", secret keys: " + secnum.value
      );

      /*
      if (this.rnp_ffi_destroy(this.ffi)) {
        throw new Error("Couldn't destroy librnp.");
      }
      */
      return true;
    },

    async saveKeyRing(fileObj, keyRingFlag) {
      let oldSuffix = ".old";
      let oldFile = fileObj.clone();
      oldFile.leafName += oldSuffix;

      // Ignore failure, fileObj.path might not exist yet.
      await OS.File.copy(fileObj.path, oldFile.path).catch(() => {});

      let u8 = null;
      let keyCount = new ctypes.size_t();

      if (keyRingFlag == this.RNP_LOAD_SAVE_SECRET_KEYS) {
        this.rnp_get_secret_key_count(this.ffi, keyCount.address());
      } else {
        this.rnp_get_public_key_count(this.ffi, keyCount.address());
      }

      let keyCountNum = parseInt(keyCount.value.toString());
      if (keyCountNum) {
        let rnp_out = new this.rnp_output_t();
        if (this.rnp_output_to_memory(rnp_out.address(), 0)) {
          throw new Error("rnp_output_to_memory failed");
        }
        if (this.rnp_save_keys(this.ffi, "GPG", rnp_out, keyRingFlag)) {
          throw new Error("rnp_save_keys failed");
        }

        let result_buf = new ctypes.uint8_t.ptr();
        let result_len = new ctypes.size_t();

        // Parameter false means "don't copy rnp_out to result_buf",
        // rather a reference to the memory is used. Be careful to
        // destroy rnp_out after we're done with the data.
        if (
          this.rnp_output_memory_get_buf(
            rnp_out,
            result_buf.address(),
            result_len.address(),
            false
          )
        ) {
          throw new Error("rnp_output_memory_get_buf failed");
        } else {
          let uint8_array = ctypes.cast(
            result_buf,
            ctypes.uint8_t.array(result_len.value).ptr
          ).contents;
          // This call creates a copy of the data, it should be
          // safe to destroy rnp_out afterwards.
          u8 = uint8_array.readTypedArray();
        }
        this.rnp_output_destroy(rnp_out);
      }

      let status = false;
      let outPathString = fileObj.path;

      try {
        if (!u8) {
          u8 = new Uint8Array();
        }
        await OS.File.writeAtomic(outPathString, u8, {
          tmpPath: outPathString + ".tmp-new",
        });
        status = true;
      } catch (err) {
        console.debug(
          "RNPLib.writeOutputToPath failed for " + outPathString + " - " + err
        );
      }

      return status;
    },

    async saveKeys() {
      let filenames = this.getFilenames();
      if (
        !(await this.saveKeyRing(
          filenames.pubring,
          this.RNP_LOAD_SAVE_PUBLIC_KEYS
        ))
      ) {
        // if saving public keys failed, don't attempt to save/replace secret keys
        return false;
      }
      return this.saveKeyRing(
        filenames.secring,
        this.RNP_LOAD_SAVE_SECRET_KEYS
      );
    },

    keep_password_cb_alive: null,

    password_cb(ffi, app_ctx, key, pgp_context, buf, buf_len) {
      const cApi = EnigmailCryptoAPI();
      let pass = cApi.sync(OpenPGPMasterpass.retrieveOpenPGPPassword());
      var passCTypes = ctypes.char.array()(pass); // UTF-8
      let passLen = passCTypes.length;

      if (buf_len < passLen) {
        return false;
      }

      let char_array = ctypes.cast(buf, ctypes.char.array(buf_len).ptr)
        .contents;

      let i;
      for (i = 0; i < passLen; ++i) {
        char_array[i] = passCTypes[i];
      }
      char_array[passLen] = 0;
      return true;
    },

    // Get a RNP library handle.
    rnp_ffi_create: librnp.declare(
      "rnp_ffi_create",
      abi,
      rnp_result_t,
      rnp_ffi_t.ptr,
      ctypes.char.ptr,
      ctypes.char.ptr
    ),

    rnp_ffi_destroy: librnp.declare(
      "rnp_ffi_destroy",
      abi,
      rnp_result_t,
      rnp_ffi_t
    ),

    rnp_ffi_set_log_fd: librnp.declare(
      "rnp_ffi_set_log_fd",
      abi,
      rnp_result_t,
      rnp_ffi_t,
      ctypes.int
    ),

    rnp_get_public_key_count: librnp.declare(
      "rnp_get_public_key_count",
      abi,
      rnp_result_t,
      rnp_ffi_t,
      ctypes.size_t.ptr
    ),

    rnp_get_secret_key_count: librnp.declare(
      "rnp_get_secret_key_count",
      abi,
      rnp_result_t,
      rnp_ffi_t,
      ctypes.size_t.ptr
    ),

    rnp_input_from_path: librnp.declare(
      "rnp_input_from_path",
      abi,
      rnp_result_t,
      rnp_input_t.ptr,
      ctypes.char.ptr
    ),

    rnp_input_from_memory: librnp.declare(
      "rnp_input_from_memory",
      abi,
      rnp_result_t,
      rnp_input_t.ptr,
      ctypes.uint8_t.ptr,
      ctypes.size_t,
      ctypes.bool
    ),

    rnp_output_to_memory: librnp.declare(
      "rnp_output_to_memory",
      abi,
      rnp_result_t,
      rnp_output_t.ptr,
      ctypes.size_t
    ),

    rnp_output_to_path: librnp.declare(
      "rnp_output_to_path",
      abi,
      rnp_result_t,
      rnp_output_t.ptr,
      ctypes.char.ptr
    ),

    rnp_decrypt: librnp.declare(
      "rnp_decrypt",
      abi,
      rnp_result_t,
      rnp_ffi_t,
      rnp_input_t,
      rnp_output_t
    ),

    rnp_output_memory_get_buf: librnp.declare(
      "rnp_output_memory_get_buf",
      abi,
      rnp_result_t,
      rnp_output_t,
      ctypes.uint8_t.ptr.ptr,
      ctypes.size_t.ptr,
      ctypes.bool
    ),

    rnp_input_destroy: librnp.declare(
      "rnp_input_destroy",
      abi,
      rnp_result_t,
      rnp_input_t
    ),

    rnp_output_destroy: librnp.declare(
      "rnp_output_destroy",
      abi,
      rnp_result_t,
      rnp_output_t
    ),

    rnp_load_keys: librnp.declare(
      "rnp_load_keys",
      abi,
      rnp_result_t,
      rnp_ffi_t,
      ctypes.char.ptr,
      rnp_input_t,
      ctypes.uint32_t
    ),

    rnp_save_keys: librnp.declare(
      "rnp_save_keys",
      abi,
      rnp_result_t,
      rnp_ffi_t,
      ctypes.char.ptr,
      rnp_output_t,
      ctypes.uint32_t
    ),

    rnp_ffi_set_pass_provider: librnp.declare(
      "rnp_ffi_set_pass_provider",
      abi,
      rnp_result_t,
      rnp_ffi_t,
      rnp_password_cb_t,
      ctypes.void_t.ptr
    ),

    rnp_identifier_iterator_create: librnp.declare(
      "rnp_identifier_iterator_create",
      abi,
      rnp_result_t,
      rnp_ffi_t,
      rnp_identifier_iterator_t.ptr,
      ctypes.char.ptr
    ),

    rnp_identifier_iterator_next: librnp.declare(
      "rnp_identifier_iterator_next",
      abi,
      rnp_result_t,
      rnp_identifier_iterator_t,
      ctypes.char.ptr.ptr
    ),

    rnp_identifier_iterator_destroy: librnp.declare(
      "rnp_identifier_iterator_destroy",
      abi,
      rnp_result_t,
      rnp_identifier_iterator_t
    ),

    rnp_locate_key: librnp.declare(
      "rnp_locate_key",
      abi,
      rnp_result_t,
      rnp_ffi_t,
      ctypes.char.ptr,
      ctypes.char.ptr,
      rnp_key_handle_t.ptr
    ),

    rnp_key_handle_destroy: librnp.declare(
      "rnp_key_handle_destroy",
      abi,
      rnp_result_t,
      rnp_key_handle_t
    ),

    rnp_key_allows_usage: librnp.declare(
      "rnp_key_allows_usage",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.char.ptr,
      ctypes.bool.ptr
    ),

    rnp_key_is_sub: librnp.declare(
      "rnp_key_is_sub",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.bool.ptr
    ),

    rnp_key_is_primary: librnp.declare(
      "rnp_key_is_primary",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.bool.ptr
    ),

    rnp_key_have_secret: librnp.declare(
      "rnp_key_have_secret",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.bool.ptr
    ),

    rnp_key_have_public: librnp.declare(
      "rnp_key_have_public",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.bool.ptr
    ),

    rnp_key_get_fprint: librnp.declare(
      "rnp_key_get_fprint",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_key_get_keyid: librnp.declare(
      "rnp_key_get_keyid",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_key_get_alg: librnp.declare(
      "rnp_key_get_alg",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_key_get_grip: librnp.declare(
      "rnp_key_get_grip",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_key_get_primary_grip: librnp.declare(
      "rnp_key_get_primary_grip",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_key_is_revoked: librnp.declare(
      "rnp_key_is_revoked",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.bool.ptr
    ),

    rnp_buffer_destroy: librnp.declare(
      "rnp_buffer_destroy",
      abi,
      ctypes.void_t,
      ctypes.void_t.ptr
    ),

    rnp_key_get_subkey_count: librnp.declare(
      "rnp_key_get_subkey_count",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.size_t.ptr
    ),

    rnp_key_get_subkey_at: librnp.declare(
      "rnp_key_get_subkey_at",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.size_t,
      rnp_key_handle_t.ptr
    ),

    rnp_key_get_creation: librnp.declare(
      "rnp_key_get_creation",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.uint32_t.ptr
    ),

    rnp_key_get_expiration: librnp.declare(
      "rnp_key_get_expiration",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.uint32_t.ptr
    ),

    rnp_key_get_bits: librnp.declare(
      "rnp_key_get_bits",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.uint32_t.ptr
    ),

    rnp_key_get_uid_count: librnp.declare(
      "rnp_key_get_uid_count",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.size_t.ptr
    ),

    rnp_key_get_primary_uid: librnp.declare(
      "rnp_key_get_primary_uid",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_key_get_uid_at: librnp.declare(
      "rnp_key_get_uid_at",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.size_t,
      ctypes.char.ptr.ptr
    ),

    rnp_key_get_uid_handle_at: librnp.declare(
      "rnp_key_get_uid_handle_at",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.size_t,
      rnp_uid_handle_t.ptr
    ),

    rnp_uid_handle_destroy: librnp.declare(
      "rnp_uid_handle_destroy",
      abi,
      rnp_result_t,
      rnp_uid_handle_t
    ),

    rnp_uid_is_revoked: librnp.declare(
      "rnp_uid_is_revoked",
      abi,
      rnp_result_t,
      rnp_uid_handle_t,
      ctypes.bool.ptr
    ),

    rnp_key_unlock: librnp.declare(
      "rnp_key_unlock",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.char.ptr
    ),

    rnp_key_lock: librnp.declare(
      "rnp_key_lock",
      abi,
      rnp_result_t,
      rnp_key_handle_t
    ),

    rnp_key_unprotect: librnp.declare(
      "rnp_key_unprotect",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.char.ptr
    ),

    rnp_key_protect: librnp.declare(
      "rnp_key_protect",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.char.ptr,
      ctypes.char.ptr,
      ctypes.char.ptr,
      ctypes.char.ptr,
      ctypes.size_t
    ),

    rnp_key_is_protected: librnp.declare(
      "rnp_key_is_protected",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.bool.ptr
    ),

    rnp_key_is_locked: librnp.declare(
      "rnp_key_is_locked",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.bool.ptr
    ),

    rnp_op_generate_create: librnp.declare(
      "rnp_op_generate_create",
      abi,
      rnp_result_t,
      rnp_op_generate_t.ptr,
      rnp_ffi_t,
      ctypes.char.ptr
    ),

    rnp_op_generate_subkey_create: librnp.declare(
      "rnp_op_generate_subkey_create",
      abi,
      rnp_result_t,
      rnp_op_generate_t.ptr,
      rnp_ffi_t,
      rnp_key_handle_t,
      ctypes.char.ptr
    ),

    rnp_op_generate_set_bits: librnp.declare(
      "rnp_op_generate_set_bits",
      abi,
      rnp_result_t,
      rnp_op_generate_t,
      ctypes.uint32_t
    ),

    rnp_op_generate_set_curve: librnp.declare(
      "rnp_op_generate_set_curve",
      abi,
      rnp_result_t,
      rnp_op_generate_t,
      ctypes.char.ptr
    ),

    rnp_op_generate_set_protection_password: librnp.declare(
      "rnp_op_generate_set_protection_password",
      abi,
      rnp_result_t,
      rnp_op_generate_t,
      ctypes.char.ptr
    ),

    rnp_op_generate_set_userid: librnp.declare(
      "rnp_op_generate_set_userid",
      abi,
      rnp_result_t,
      rnp_op_generate_t,
      ctypes.char.ptr
    ),

    rnp_op_generate_set_expiration: librnp.declare(
      "rnp_op_generate_set_expiration",
      abi,
      rnp_result_t,
      rnp_op_generate_t,
      ctypes.uint32_t
    ),

    rnp_op_generate_execute: librnp.declare(
      "rnp_op_generate_execute",
      abi,
      rnp_result_t,
      rnp_op_generate_t
    ),

    rnp_op_generate_get_key: librnp.declare(
      "rnp_op_generate_get_key",
      abi,
      rnp_result_t,
      rnp_op_generate_t,
      rnp_key_handle_t.ptr
    ),

    rnp_op_generate_destroy: librnp.declare(
      "rnp_op_generate_destroy",
      abi,
      rnp_result_t,
      rnp_op_generate_t
    ),

    rnp_guess_contents: librnp.declare(
      "rnp_guess_contents",
      abi,
      rnp_result_t,
      rnp_input_t,
      ctypes.char.ptr.ptr
    ),

    rnp_import_signatures: librnp.declare(
      "rnp_import_signatures",
      abi,
      rnp_result_t,
      rnp_ffi_t,
      rnp_input_t,
      ctypes.uint32_t,
      ctypes.char.ptr.ptr
    ),

    rnp_import_keys: librnp.declare(
      "rnp_import_keys",
      abi,
      rnp_result_t,
      rnp_ffi_t,
      rnp_input_t,
      ctypes.uint32_t,
      ctypes.char.ptr.ptr
    ),

    rnp_key_remove: librnp.declare(
      "rnp_key_remove",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.uint32_t
    ),

    rnp_op_encrypt_create: librnp.declare(
      "rnp_op_encrypt_create",
      abi,
      rnp_result_t,
      rnp_op_encrypt_t.ptr,
      rnp_ffi_t,
      rnp_input_t,
      rnp_output_t
    ),

    rnp_op_sign_cleartext_create: librnp.declare(
      "rnp_op_sign_cleartext_create",
      abi,
      rnp_result_t,
      rnp_op_sign_t.ptr,
      rnp_ffi_t,
      rnp_input_t,
      rnp_output_t
    ),

    rnp_op_sign_detached_create: librnp.declare(
      "rnp_op_sign_detached_create",
      abi,
      rnp_result_t,
      rnp_op_sign_t.ptr,
      rnp_ffi_t,
      rnp_input_t,
      rnp_output_t
    ),

    rnp_op_encrypt_add_recipient: librnp.declare(
      "rnp_op_encrypt_add_recipient",
      abi,
      rnp_result_t,
      rnp_op_encrypt_t,
      rnp_key_handle_t
    ),

    rnp_op_encrypt_add_signature: librnp.declare(
      "rnp_op_encrypt_add_signature",
      abi,
      rnp_result_t,
      rnp_op_encrypt_t,
      rnp_key_handle_t,
      rnp_op_sign_signature_t.ptr
    ),

    rnp_op_sign_add_signature: librnp.declare(
      "rnp_op_sign_add_signature",
      abi,
      rnp_result_t,
      rnp_op_sign_t,
      rnp_key_handle_t,
      rnp_op_sign_signature_t.ptr
    ),

    rnp_op_encrypt_set_armor: librnp.declare(
      "rnp_op_encrypt_set_armor",
      abi,
      rnp_result_t,
      rnp_op_encrypt_t,
      ctypes.bool
    ),

    rnp_op_sign_set_armor: librnp.declare(
      "rnp_op_sign_set_armor",
      abi,
      rnp_result_t,
      rnp_op_sign_t,
      ctypes.bool
    ),

    rnp_op_encrypt_set_hash: librnp.declare(
      "rnp_op_encrypt_set_hash",
      abi,
      rnp_result_t,
      rnp_op_encrypt_t,
      ctypes.char.ptr
    ),

    rnp_op_sign_set_hash: librnp.declare(
      "rnp_op_sign_set_hash",
      abi,
      rnp_result_t,
      rnp_op_sign_t,
      ctypes.char.ptr
    ),

    rnp_op_encrypt_set_cipher: librnp.declare(
      "rnp_op_encrypt_set_cipher",
      abi,
      rnp_result_t,
      rnp_op_encrypt_t,
      ctypes.char.ptr
    ),

    rnp_op_sign_execute: librnp.declare(
      "rnp_op_sign_execute",
      abi,
      rnp_result_t,
      rnp_op_sign_t
    ),

    rnp_op_sign_destroy: librnp.declare(
      "rnp_op_sign_destroy",
      abi,
      rnp_result_t,
      rnp_op_sign_t
    ),

    rnp_op_encrypt_execute: librnp.declare(
      "rnp_op_encrypt_execute",
      abi,
      rnp_result_t,
      rnp_op_encrypt_t
    ),

    rnp_op_encrypt_destroy: librnp.declare(
      "rnp_op_encrypt_destroy",
      abi,
      rnp_result_t,
      rnp_op_encrypt_t
    ),

    rnp_key_export: librnp.declare(
      "rnp_key_export",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      rnp_output_t,
      ctypes.uint32_t
    ),

    rnp_key_export_revocation: librnp.declare(
      "rnp_key_export_revocation",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      rnp_output_t,
      ctypes.uint32_t,
      ctypes.char.ptr,
      ctypes.char.ptr,
      ctypes.char.ptr
    ),

    rnp_output_to_armor: librnp.declare(
      "rnp_output_to_armor",
      abi,
      rnp_result_t,
      rnp_output_t,
      rnp_output_t.ptr,
      ctypes.char.ptr
    ),

    rnp_output_finish: librnp.declare(
      "rnp_output_finish",
      abi,
      rnp_result_t,
      rnp_output_t
    ),

    rnp_op_verify_create: librnp.declare(
      "rnp_op_verify_create",
      abi,
      rnp_result_t,
      rnp_op_verify_t.ptr,
      rnp_ffi_t,
      rnp_input_t,
      rnp_output_t
    ),

    rnp_op_verify_detached_create: librnp.declare(
      "rnp_op_verify_detached_create",
      abi,
      rnp_result_t,
      rnp_op_verify_t.ptr,
      rnp_ffi_t,
      rnp_input_t,
      rnp_input_t
    ),

    rnp_op_verify_execute: librnp.declare(
      "rnp_op_verify_execute",
      abi,
      rnp_result_t,
      rnp_op_verify_t
    ),

    rnp_op_verify_destroy: librnp.declare(
      "rnp_op_verify_destroy",
      abi,
      rnp_result_t,
      rnp_op_verify_t
    ),

    rnp_op_verify_get_signature_count: librnp.declare(
      "rnp_op_verify_get_signature_count",
      abi,
      rnp_result_t,
      rnp_op_verify_t,
      ctypes.size_t.ptr
    ),

    rnp_op_verify_get_signature_at: librnp.declare(
      "rnp_op_verify_get_signature_at",
      abi,
      rnp_result_t,
      rnp_op_verify_t,
      ctypes.size_t,
      rnp_op_verify_signature_t.ptr
    ),

    rnp_op_verify_signature_get_handle: librnp.declare(
      "rnp_op_verify_signature_get_handle",
      abi,
      rnp_result_t,
      rnp_op_verify_signature_t,
      rnp_signature_handle_t.ptr
    ),

    rnp_op_verify_signature_get_status: librnp.declare(
      "rnp_op_verify_signature_get_status",
      abi,
      rnp_result_t,
      rnp_op_verify_signature_t
    ),

    rnp_op_verify_signature_get_key: librnp.declare(
      "rnp_op_verify_signature_get_key",
      abi,
      rnp_result_t,
      rnp_op_verify_signature_t,
      rnp_key_handle_t.ptr
    ),

    rnp_op_verify_signature_get_times: librnp.declare(
      "rnp_op_verify_signature_get_times",
      abi,
      rnp_result_t,
      rnp_op_verify_signature_t,
      ctypes.uint32_t.ptr,
      ctypes.uint32_t.ptr
    ),

    rnp_uid_get_signature_count: librnp.declare(
      "rnp_uid_get_signature_count",
      abi,
      rnp_result_t,
      rnp_uid_handle_t,
      ctypes.size_t.ptr
    ),

    rnp_uid_get_signature_at: librnp.declare(
      "rnp_uid_get_signature_at",
      abi,
      rnp_result_t,
      rnp_uid_handle_t,
      ctypes.size_t,
      rnp_signature_handle_t.ptr
    ),

    rnp_signature_get_creation: librnp.declare(
      "rnp_signature_get_creation",
      abi,
      rnp_result_t,
      rnp_signature_handle_t,
      ctypes.uint32_t.ptr
    ),

    rnp_signature_get_keyid: librnp.declare(
      "rnp_signature_get_keyid",
      abi,
      rnp_result_t,
      rnp_signature_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_signature_get_signer: librnp.declare(
      "rnp_signature_get_signer",
      abi,
      rnp_result_t,
      rnp_signature_handle_t,
      rnp_key_handle_t.ptr
    ),

    rnp_signature_handle_destroy: librnp.declare(
      "rnp_signature_handle_destroy",
      abi,
      rnp_result_t,
      rnp_signature_handle_t
    ),

    rnp_enarmor: librnp.declare(
      "rnp_enarmor",
      abi,
      rnp_result_t,
      rnp_input_t,
      rnp_output_t,
      ctypes.char.ptr
    ),

    rnp_op_verify_get_protection_info: librnp.declare(
      "rnp_op_verify_get_protection_info",
      abi,
      rnp_result_t,
      rnp_op_verify_t,
      ctypes.char.ptr.ptr,
      ctypes.char.ptr.ptr,
      ctypes.bool.ptr
    ),

    rnp_op_verify_get_recipient_count: librnp.declare(
      "rnp_op_verify_get_recipient_count",
      abi,
      rnp_result_t,
      rnp_op_verify_t,
      ctypes.size_t.ptr
    ),

    rnp_op_verify_get_used_recipient: librnp.declare(
      "rnp_op_verify_get_used_recipient",
      abi,
      rnp_result_t,
      rnp_op_verify_t,
      rnp_recipient_handle_t.ptr
    ),

    rnp_op_verify_get_recipient_at: librnp.declare(
      "rnp_op_verify_get_recipient_at",
      abi,
      rnp_result_t,
      rnp_op_verify_t,
      ctypes.size_t,
      rnp_recipient_handle_t.ptr
    ),

    rnp_recipient_get_keyid: librnp.declare(
      "rnp_recipient_get_keyid",
      abi,
      rnp_result_t,
      rnp_recipient_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_recipient_get_alg: librnp.declare(
      "rnp_recipient_get_alg",
      abi,
      rnp_result_t,
      rnp_recipient_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_op_verify_get_symenc_count: librnp.declare(
      "rnp_op_verify_get_symenc_count",
      abi,
      rnp_result_t,
      rnp_op_verify_t,
      ctypes.size_t.ptr
    ),

    rnp_op_verify_get_used_symenc: librnp.declare(
      "rnp_op_verify_get_used_symenc",
      abi,
      rnp_result_t,
      rnp_op_verify_t,
      rnp_symenc_handle_t.ptr
    ),

    rnp_op_verify_get_symenc_at: librnp.declare(
      "rnp_op_verify_get_symenc_at",
      abi,
      rnp_result_t,
      rnp_op_verify_t,
      ctypes.size_t,
      rnp_symenc_handle_t.ptr
    ),

    rnp_symenc_get_cipher: librnp.declare(
      "rnp_symenc_get_cipher",
      abi,
      rnp_result_t,
      rnp_symenc_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_symenc_get_aead_alg: librnp.declare(
      "rnp_symenc_get_aead_alg",
      abi,
      rnp_result_t,
      rnp_symenc_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_symenc_get_hash_alg: librnp.declare(
      "rnp_symenc_get_hash_alg",
      abi,
      rnp_result_t,
      rnp_symenc_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_symenc_get_s2k_type: librnp.declare(
      "rnp_symenc_get_s2k_type",
      abi,
      rnp_result_t,
      rnp_symenc_handle_t,
      ctypes.char.ptr.ptr
    ),

    rnp_symenc_get_s2k_iterations: librnp.declare(
      "rnp_symenc_get_s2k_iterations",
      abi,
      rnp_result_t,
      rnp_symenc_handle_t,
      ctypes.uint32_t.ptr
    ),

    rnp_key_set_expiration: librnp.declare(
      "rnp_key_set_expiration",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.uint32_t
    ),

    rnp_key_revoke: librnp.declare(
      "rnp_key_revoke",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.uint32_t,
      ctypes.char.ptr,
      ctypes.char.ptr,
      ctypes.char.ptr
    ),

    rnp_key_export_autocrypt: librnp.declare(
      "rnp_key_export_autocrypt",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      rnp_key_handle_t,
      ctypes.char.ptr,
      rnp_output_t,
      ctypes.uint32_t
    ),

    rnp_key_valid_till: librnp.declare(
      "rnp_key_valid_till",
      abi,
      rnp_result_t,
      rnp_key_handle_t,
      ctypes.uint32_t.ptr
    ),

    rnp_uid_is_valid: librnp.declare(
      "rnp_uid_is_valid",
      abi,
      rnp_result_t,
      rnp_uid_handle_t,
      ctypes.bool.ptr
    ),

    rnp_uid_is_primary: librnp.declare(
      "rnp_uid_is_primary",
      abi,
      rnp_result_t,
      rnp_uid_handle_t,
      ctypes.bool.ptr
    ),

    rnp_signature_is_valid: librnp.declare(
      "rnp_signature_is_valid",
      abi,
      rnp_result_t,
      rnp_signature_handle_t,
      ctypes.uint32_t
    ),

    rnp_result_t,
    rnp_ffi_t,
    rnp_password_cb_t,
    rnp_input_t,
    rnp_output_t,
    rnp_key_handle_t,
    rnp_uid_handle_t,
    rnp_identifier_iterator_t,
    rnp_op_generate_t,
    rnp_op_encrypt_t,
    rnp_op_sign_t,
    rnp_op_sign_signature_t,
    rnp_op_verify_t,
    rnp_op_verify_signature_t,
    rnp_signature_handle_t,
    rnp_recipient_handle_t,
    rnp_symenc_handle_t,

    RNP_LOAD_SAVE_PUBLIC_KEYS: 1,
    RNP_LOAD_SAVE_SECRET_KEYS: 2,
    RNP_LOAD_SAVE_PERMISSIVE: 256,

    RNP_KEY_REMOVE_PUBLIC: 1,
    RNP_KEY_REMOVE_SECRET: 2,
    RNP_KEY_REMOVE_SUBKEYS: 4,

    RNP_KEY_EXPORT_ARMORED: 1,
    RNP_KEY_EXPORT_PUBLIC: 2,
    RNP_KEY_EXPORT_SECRET: 4,
    RNP_KEY_EXPORT_SUBKEYS: 8,

    RNP_SUCCESS: 0x00000000,

    /* Common error codes */
    RNP_ERROR_GENERIC: 0x10000000, // 268435456
    RNP_ERROR_BAD_FORMAT: 0x10000001, // 268435457
    RNP_ERROR_BAD_PARAMETERS: 0x10000002, // 268435458
    RNP_ERROR_NOT_IMPLEMENTED: 0x10000003, // 268435459
    RNP_ERROR_NOT_SUPPORTED: 0x10000004, // 268435460
    RNP_ERROR_OUT_OF_MEMORY: 0x10000005, // 268435461
    RNP_ERROR_SHORT_BUFFER: 0x10000006, // 268435462
    RNP_ERROR_NULL_POINTER: 0x10000007, // 268435463

    /* Storage */
    RNP_ERROR_ACCESS: 0x11000000, // 285212672
    RNP_ERROR_READ: 0x11000001, // 285212673
    RNP_ERROR_WRITE: 0x11000002, // 285212674

    /* Crypto */
    RNP_ERROR_BAD_STATE: 0x12000000, // 301989888
    RNP_ERROR_MAC_INVALID: 0x12000001, // 301989889
    RNP_ERROR_SIGNATURE_INVALID: 0x12000002, // 301989890
    RNP_ERROR_KEY_GENERATION: 0x12000003, // 301989891
    RNP_ERROR_BAD_PASSWORD: 0x12000004, // 301989892
    RNP_ERROR_KEY_NOT_FOUND: 0x12000005, // 301989893
    RNP_ERROR_NO_SUITABLE_KEY: 0x12000006, // 301989894
    RNP_ERROR_DECRYPT_FAILED: 0x12000007, // 301989895
    RNP_ERROR_RNG: 0x12000008, // 301989896
    RNP_ERROR_SIGNING_FAILED: 0x12000009, // 301989897
    RNP_ERROR_NO_SIGNATURES_FOUND: 0x1200000a, // 301989898

    RNP_ERROR_SIGNATURE_EXPIRED: 0x1200000b, // 301989899

    /* Parsing */
    RNP_ERROR_NOT_ENOUGH_DATA: 0x13000000, // 318767104
    RNP_ERROR_UNKNOWN_TAG: 0x13000001, // 318767105
    RNP_ERROR_PACKET_NOT_CONSUMED: 0x13000002, // 318767106
    RNP_ERROR_NO_USERID: 0x13000003, // 318767107
    RNP_ERROR_EOF: 0x13000004, // 318767108
  };
}
