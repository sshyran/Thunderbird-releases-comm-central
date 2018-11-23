/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var MODULE_NAME = 'test-plugin-crashing';

var RELATIVE_ROOT = '../shared-modules';
var MODULE_REQUIRES = ['folder-display-helpers', 'content-tab-helpers'];

var frame = {};
ChromeUtils.import("chrome://mozmill/content/modules/frame.js", frame);

ChromeUtils.import('resource://gre/modules/Services.jsm');

var gContentWindow = null;
var gJSObject = null;
var gTabDoc = null;
var gOldStartPage = null;
var gOldPluginCrashDocPage = null;
var crashReporter = null;
var kPluginId = "test-plugin";
var kStartPagePref = "mailnews.start_page.override_url";
var kPluginCrashDocPref = "plugins.crash.supportUrl";
// RELATIVE_ROOT messes with the collector, so we have to bring the path back
// so we get the right path for the resources.
var kUrl = collector.addHttpResource('../content-tabs/html', '');
var kPluginUrl = kUrl + "plugin.html";
var kPluginCrashDocUrl = kUrl + "plugin_crashed_help.html";

function setupModule(module) {
  let fdh = collector.getModule('folder-display-helpers');
  fdh.installInto(module);
  let cth = collector.getModule('content-tab-helpers');
  cth.installInto(module);

  // Set the pref so that what's new opens a local url - we'll save the old
  // url and put it back in the module teardown.
  gOldStartPage = Services.prefs.getCharPref(kStartPagePref);
  gOldPluginCrashDocPage = Services.prefs.getCharPref(kPluginCrashDocPref);

  Services.prefs.setCharPref(kStartPagePref, kPluginUrl);
  Services.prefs.setCharPref(kPluginCrashDocPref, kPluginCrashDocUrl);

  try {
    crashReporter = Cc["@mozilla.org/toolkit/crash-reporter;1"]
                      .getService(Ci.nsICrashReporter);
    // The crash reporter must be enabled.
    assert_true(crashReporter.enabled, "Mandatory Crash reporter is not enabled");
  } catch (e) {
    // Crashreporter is not working.
  }


  /* Bug 689580 - these crash tests fail randomly on 64-bit OSX.  We'll
   * disable them for now, until we can figure out what's going on.
   */
  let is64BitOSX = (mc.mozmillModule.isMac &&
                    Services.appinfo.XPCOMABI.includes("x86_64-"));

  // These tests are no good if the crash reporter is disabled, or if
  // we don't have out-of-process plugins enabled.
  if (is64BitOSX ||  // XXX Remove once Bug 689580 is resolved
      !plugins_run_in_separate_processes(mc) || !crashReporter ||
      !crashReporter.enabled) {
    let funcsToSkip = [test_can_crash_plugin,
                       test_crashed_plugin_notification_bar,
                       test_crashed_plugin_notification_inline];

    funcsToSkip.forEach(function(func) {
      func.__force_skip__ = true;
    });
  }
  let plugin = get_test_plugin();
  plugin.enabledState = plugin.STATE_ENABLED;
};

function teardownModule(module) {
  Services.prefs.setCharPref(kStartPagePref, gOldStartPage);
  Services.prefs.setCharPref(kPluginCrashDocPref, gOldPluginCrashDocPage);
}

function setupTest() {
  let tab = open_content_tab_with_click(mc.menus.helpMenu.whatsNew, kPluginUrl);
  assert_tab_has_title(tab, "Plugin Test");

  // Check that window.content is set up correctly wrt content-primary and
  // content-targetable.
  if (mc.window.content.location != kPluginUrl)
    throw new Error("window.content is not set to the url loaded, incorrect type=\"...\"?");

  gContentWindow = mc.tabmail.selectedTab.browser.contentWindow;
  gJSObject = gContentWindow.wrappedJSObject;

  // Strangely, in order to manipulate the embedded plugin,
  // we have to use getElementById within the context of the
  // wrappedJSObject of the content tab browser.
  gTabDoc = gJSObject.window.document;

}

function teardownTest() {
  let tab = mc.tabmail.selectedTab;
  mc.tabmail.closeTab(tab);
}

/* PluginCrashObserver lets us plan for and wait for plugin crashes. After
 * a plugin has crashed, PluginCrashObserver cleans up the minidump files
 * left behind.
 *
 * IMPORTANT:  Calls to planForCrash must be followed by waitForCrash in
 * order to remove PluginCrashObserver from the nsIObserverService.
 */
var PluginCrashObserver = {
  _sawCrash: false,

  planForCrash: function(aController) {
    this._sawCrash = false;
    Services.obs.addObserver(this, "plugin-crashed");
  },

  waitForCrash: function(aController) {
    if (!this._sawCrash)
      aController.waitFor(() => this._sawCrash, "Timeout waiting for crash",
                          5000, 100);

    Services.obs.removeObserver(this, "plugin-crashed");
  },

  observe: function(aSubject, aTopic, aData) {
    if (aTopic != "plugin-crashed")
      return;

    try {
      this.removeMinidump(aSubject.QueryInterface(Ci.nsIPropertyBag2));
    } catch (ex) {
      Cu.reportError(ex);
      frame.events.fail({exception: ex, test: frame.events.currentTest});
    }
  },

  removeMinidump: function PluginCrashObserver_removeMinidump(aPropBag) {
    this._sawCrash = true;

    let profD = Services.dirsvc.get("ProfD", Ci.nsIFile);
    profD.append("minidumps");

    // Let's check to see if a minidump was created.  If so, delete
    // it (along with the .extra file)
    let crashId = aPropBag.getPropertyAsAString("pluginDumpID");
    let dumpFile = profD.clone();
    dumpFile.append(crashId + ".dmp");
    let extraFile = profD.clone();
    extraFile.append(crashId + ".extra");

    // Retry deletion until crash reporter releases the file.
    function remove_locked_file(aFile) {
      function try_removal(aFile) {
        try {
          // Yield to the event loop while waiting for the file to get unlocked.
          mc.sleep(0);
          aFile.remove(false);
        } catch (e) {
          if (e.result == Cr.NS_ERROR_FILE_IS_LOCKED)
            return false;

          throw e;
        }
        return true;
      }

      mc.waitFor(() => try_removal(aFile) === true,
                 `File ${aFile.leafName} couldn't be removed due to a lock`, 20000, 250);
      assert_false(aFile.exists());
    }

    if (dumpFile.exists())
      remove_locked_file(dumpFile);

    if (extraFile.exists())
      remove_locked_file(extraFile);
  }
}

/* Crash the plugin */
function crash_plugin() {
  try {
    let plugin = gTabDoc.getElementById(kPluginId);
    PluginCrashObserver.planForCrash(mc);
    plugin.crash();
  } catch(e) {
    PluginCrashObserver.waitForCrash(mc);
    return true;
  }
  return false;
}

/* A quick sanity check - let's ensure that we can actually
 * crash the plugin.
 */
function test_can_crash_plugin() {
  assert_true(crash_plugin());
}

/* Test to check that if a plugin crashes, and the plugin's
 * <object> is too small to display a message, then a
 * notification box appears to tell us about the crash.
 */
function test_crashed_plugin_notification_bar() {
  let plugin = gTabDoc.getElementById(kPluginId);
  plugin.style.width = '10px';
  plugin.style.height = '10px';

  NotificationWatcher.planForNotification(mc);
  assert_true(crash_plugin());
  NotificationWatcher.waitForNotification(mc);
}

/* Test that if a plugin crashes, and the plugin's <object>
 * is large enough to display a message, it'll display the
 * appropriate crash message.
 */
function test_crashed_plugin_notification_inline() {
  let plugin = gTabDoc.getElementById(kPluginId);

  plugin.style.width = '500px';
  plugin.style.height = '500px';

  assert_true(crash_plugin());

  /* This function attempts to return the status div on the
   * crashed plugin widget.  Returns null on failure.
   */
  function getStatusDiv() {
    let submitDiv = gContentWindow.document
                                  .getAnonymousElementByAttribute(plugin,
                                                                  "class",
                                                                  "submitStatus");
    return submitDiv;
  }

  let submitDiv = null;
  mc.waitFor(() => (submitDiv = getStatusDiv()) != null,
             "Timeout waiting for submit status to appear",
             5000, 100);

  assert_equals(null, mc.tabmail.selectedTab.browser.parentNode
                                .getNotificationWithValue("plugin-crashed"));

  let statusString = submitDiv.getAttribute("status");
  if (!statusString) {
    let submitStatusChanged = false;
    let observer = new gContentWindow.MutationObserver(function handleMutations(mutations) {
      submitStatusChanged = true;
    });
    observer.observe(submitDiv, { attributes: true });

    mc.waitFor(() => submitStatusChanged,
               "Timed out: Notification existed and did not disappear.");
    observer.disconnect();
  }

  // Depending on the environment we're running this test on,
  // the status attribute might be "noReport" or "please".
  assert_true(statusString == "noReport" || statusString == "please",
              "Expected the status to be \"noReport\" or \"please\". " +
              "Instead, it was " + statusString);

  // Make sure that the help link in the inline notification works.
  let helpIcon = gContentWindow.document
                               .getAnonymousElementByAttribute(plugin,
                                                               "class",
                                                               "helpIcon");
  assert_not_equals(null, helpIcon, "Help Icon should have been available");

  let helpTab = open_content_tab_with_click(helpIcon, kPluginCrashDocUrl);
  assert_tab_has_title(helpTab, "Plugin Crashed Help");
  mc.tabmail.closeTab(helpTab);
}
