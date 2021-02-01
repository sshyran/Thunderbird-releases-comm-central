/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from ../../../../toolkit/mozapps/extensions/content/aboutaddons.js */

const THUNDERBIRD_THEME_PREVIEWS = new Map([
  [
    "thunderbird-compact-light@mozilla.org",
    "chrome://mozapps/content/extensions/firefox-compact-light.svg",
  ],
  [
    "thunderbird-compact-dark@mozilla.org",
    "chrome://mozapps/content/extensions/firefox-compact-dark.svg",
  ],
]);

XPCOMUtils.defineLazyModuleGetters(this, {
  ExtensionData: "resource://gre/modules/Extension.jsm",
});

(async function() {
  // Fix the "Search on addons.mozilla.org" placeholder text in the searchbox.
  let textbox = document.querySelector("search-addons > search-textbox");
  let placeholder = textbox.getAttribute("placeholder");
  placeholder = placeholder.replace(
    "addons.mozilla.org",
    "addons.thunderbird.net"
  );
  textbox.setAttribute("placeholder", placeholder);

  // Add our stylesheet.
  let contentStylesheet = document.createProcessingInstruction(
    "xml-stylesheet",
    'href="chrome://messenger/content/aboutAddonsExtra.css" type="text/css"'
  );
  document.insertBefore(contentStylesheet, document.documentElement);

  // Override logic for detecting unsigned add-ons.
  window.isCorrectlySigned = function() {
    return true;
  };
  // Add logic to detect add-ons using the unsupported legacy API.
  let getMozillaAddonMessageInfo = window.getAddonMessageInfo;
  window.getAddonMessageInfo = async function(addon) {
    const formatString = (name, args) =>
      extBundle.formatStringFromName(
        `details.notification.${name}`,
        args,
        args.length
      );
    const { name } = addon;
    const appName = brandBundle.GetStringFromName("brandShortName");
    let data = new ExtensionData(addon.getResourceURI());
    await data.loadManifest();
    if (data.manifest.legacy) {
      return {
        message: formatString("incompatible", [
          name,
          appName,
          Services.appinfo.version,
        ]),
        type: "warning",
      };
    }
    return getMozillaAddonMessageInfo(addon);
  };
  document.querySelectorAll("addon-card").forEach(card => card.updateMessage());

  // Load our permissions strings.
  delete window.browserBundle;
  window.browserBundle = Services.strings.createBundle(
    "chrome://messenger/locale/addons.properties"
  );

  // Load our theme screenshots.
  let _getScreenshotUrlForAddon = getScreenshotUrlForAddon;
  getScreenshotUrlForAddon = function(addon) {
    if (THUNDERBIRD_THEME_PREVIEWS.has(addon.id)) {
      return THUNDERBIRD_THEME_PREVIEWS.get(addon.id);
    }
    return _getScreenshotUrlForAddon(addon);
  };
})();
