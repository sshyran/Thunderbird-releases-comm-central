/* -*- Mode: JavaScript; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * @file
 * GUI-side code for managing folder subscriptions.
 */

var { Feed } = ChromeUtils.import("resource:///modules/Feed.jsm");
var { FeedUtils } = ChromeUtils.import("resource:///modules/FeedUtils.jsm");
var { MailServices } = ChromeUtils.import(
  "resource:///modules/MailServices.jsm"
);
var { AppConstants } = ChromeUtils.import(
  "resource://gre/modules/AppConstants.jsm"
);
var { FileUtils } = ChromeUtils.import("resource://gre/modules/FileUtils.jsm");
var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
var { PluralForm } = ChromeUtils.import(
  "resource://gre/modules/PluralForm.jsm"
);

var FeedSubscriptions = {
  get mMainWin() {
    return Services.wm.getMostRecentWindow("mail:3pane");
  },

  get mTree() {
    return document.getElementById("rssSubscriptionsList");
  },

  mFeedContainers: [],
  mRSSServer: null,
  mActionMode: null,
  kSubscribeMode: 1,
  kUpdateMode: 2,
  kMoveMode: 3,
  kCopyMode: 4,
  kImportingOPML: 5,
  kVerifyUrlMode: 6,

  get FOLDER_ACTIONS() {
    return (
      Ci.nsIMsgFolderNotificationService.folderAdded |
      Ci.nsIMsgFolderNotificationService.folderDeleted |
      Ci.nsIMsgFolderNotificationService.folderRenamed |
      Ci.nsIMsgFolderNotificationService.folderMoveCopyCompleted
    );
  },

  onLoad() {
    // Extract the folder argument.
    let folder;
    if (window.arguments && window.arguments[0].folder) {
      folder = window.arguments[0].folder;
    }

    // Ensure dialog is fully loaded before selecting, to get visible row.
    setTimeout(() => {
      FeedSubscriptions.refreshSubscriptionView(folder);
    }, 100);
    let message = FeedUtils.strings.GetStringFromName("subscribe-loading");
    this.updateStatusItem("statusText", message);

    FeedUtils.CANCEL_REQUESTED = false;

    if (this.mMainWin) {
      this.mMainWin.FeedFolderNotificationService = MailServices.mfn;
      this.mMainWin.FeedFolderNotificationService.addListener(
        this.FolderListener,
        this.FOLDER_ACTIONS
      );
    }
  },

  onClose() {
    let dismissDialog = true;

    // If we are in the middle of subscribing to a feed, inform the user that
    // dismissing the dialog right now will abort the feed subscription.
    if (this.mActionMode == this.kSubscribeMode) {
      let pTitle = FeedUtils.strings.GetStringFromName(
        "subscribe-cancelSubscriptionTitle"
      );
      let pMessage = FeedUtils.strings.GetStringFromName(
        "subscribe-cancelSubscription"
      );
      dismissDialog = !Services.prompt.confirmEx(
        window,
        pTitle,
        pMessage,
        Ci.nsIPromptService.STD_YES_NO_BUTTONS,
        null,
        null,
        null,
        null,
        {}
      );
    }

    if (dismissDialog) {
      FeedUtils.CANCEL_REQUESTED = this.mActionMode == this.kSubscribeMode;
      if (this.mMainWin) {
        this.mMainWin.FeedFolderNotificationService.removeListener(
          this.FolderListener,
          this.FOLDER_ACTIONS
        );
        delete this.mMainWin.FeedFolderNotificationService;
      }
    }

    return dismissDialog;
  },

  refreshSubscriptionView(aSelectFolder, aSelectFeedUrl) {
    let item = this.mView.currentItem;
    this.loadSubscriptions();
    this.mTree.view = this.mView;

    if (aSelectFolder && !aSelectFeedUrl) {
      this.selectFolder(aSelectFolder);
    } else if (item) {
      // If no folder to select, try to select the pre rebuild selection, in
      // an existing window.  For folderpane changes in a feed account.
      let rootFolder = item.container
        ? item.folder.rootFolder
        : item.parentFolder.rootFolder;
      if (item.container) {
        if (!this.selectFolder(item.folder, { open: item.open })) {
          // The item no longer exists, an ancestor folder was deleted or
          // renamed/moved.
          this.selectFolder(rootFolder);
        }
      } else {
        let url =
          item.parentFolder == aSelectFolder ? aSelectFeedUrl : item.url;
        this.selectFeed({ folder: rootFolder, url }, null);
      }
    }

    this.mView.tree.ensureRowIsVisible(this.mView.selection.currentIndex);
    this.clearStatusInfo();
  },

  mView: {
    kRowIndexUndefined: -1,

    get currentItem() {
      // Get the current selection, if any.
      let seln = this.selection;
      let currentSelectionIndex = seln ? seln.currentIndex : null;
      let item;
      if (currentSelectionIndex != null) {
        item = this.getItemAtIndex(currentSelectionIndex);
      }

      return item;
    },

    /* nsITreeView */
    /* eslint-disable no-multi-spaces */
    tree: null,

    mRowCount: 0,
    get rowCount() {
      return this.mRowCount;
    },

    _selection: null,
    get selection() {
      return this._selection;
    },
    set selection(val) {
      this._selection = val;
    },

    setTree(aTree) {
      this.tree = aTree;
    },
    isSeparator(aRow) {
      return false;
    },
    isSorted() {
      return false;
    },
    isEditable(aRow, aColumn) {
      return false;
    },

    getProgressMode(aRow, aCol) {},
    cycleHeader(aCol) {},
    cycleCell(aRow, aCol) {},
    selectionChanged() {},
    getRowProperties(aRow) {
      return "";
    },
    getColumnProperties(aCol) {
      return "";
    },
    getCellValue(aRow, aColumn) {},
    setCellValue(aRow, aColumn, aValue) {},
    setCellText(aRow, aColumn, aValue) {},
    /* eslint-enable no-multi-spaces */

    getCellProperties(aRow, aColumn) {
      let item = this.getItemAtIndex(aRow);
      if (!item) {
        return "";
      }

      if (AppConstants.MOZ_APP_NAME != "thunderbird") {
        if (!item.folder) {
          return "serverType-rss";
        } else if (item.folder.isServer) {
          return "serverType-rss isServer-true";
        }

        return "livemark";
      }

      let folder = item.folder;
      let properties = "folderNameCol";
      let mainWin = FeedSubscriptions.mMainWin;
      if (!mainWin) {
        let hasFeeds = FeedUtils.getFeedUrlsInFolder(folder);
        if (!folder) {
          properties += " isFeed-true";
        } else if (hasFeeds) {
          properties += " isFeedFolder-true";
        } else if (folder.isServer) {
          properties += " serverType-rss isServer-true";
        }
      } else {
        let url = folder ? null : item.url;
        folder = folder || item.parentFolder;
        properties = mainWin.getFolderProperties(folder, item.open);
        properties += mainWin.FeedUtils.getFolderProperties(folder, url);
        if (
          this.selection.currentIndex == aRow &&
          url &&
          item.options.updates.enabled &&
          properties.includes("isPaused")
        ) {
          item.options.updates.enabled = false;
          FeedSubscriptions.updateFeedData(item);
        }
      }

      item.properties = properties;
      return properties;
    },

    isContainer(aRow) {
      let item = this.getItemAtIndex(aRow);
      return item ? item.container : false;
    },

    isContainerOpen(aRow) {
      let item = this.getItemAtIndex(aRow);
      return item ? item.open : false;
    },

    isContainerEmpty(aRow) {
      let item = this.getItemAtIndex(aRow);
      if (!item) {
        return false;
      }

      return item.children.length == 0;
    },

    getItemAtIndex(aRow) {
      if (aRow < 0 || aRow >= FeedSubscriptions.mFeedContainers.length) {
        return null;
      }

      return FeedSubscriptions.mFeedContainers[aRow];
    },

    getItemInViewIndex(aFolder) {
      if (!aFolder || !(aFolder instanceof Ci.nsIMsgFolder)) {
        return null;
      }

      for (let index = 0; index < this.rowCount; index++) {
        // Find the visible folder in the view.
        let item = this.getItemAtIndex(index);
        if (item && item.container && item.url == aFolder.URI) {
          return index;
        }
      }

      return null;
    },

    removeItemAtIndex(aRow, aNoSelect) {
      let itemToRemove = this.getItemAtIndex(aRow);
      if (!itemToRemove) {
        return;
      }

      if (itemToRemove.container && itemToRemove.open) {
        // Close it, if open container.
        this.toggleOpenState(aRow);
      }

      let parentIndex = this.getParentIndex(aRow);
      let hasNextSibling = this.hasNextSibling(aRow, aRow);
      if (parentIndex != this.kRowIndexUndefined) {
        let parent = this.getItemAtIndex(parentIndex);
        if (parent) {
          for (let index = 0; index < parent.children.length; index++) {
            if (parent.children[index] == itemToRemove) {
              parent.children.splice(index, 1);
              break;
            }
          }
        }
      }

      // Now remove it from our view.
      FeedSubscriptions.mFeedContainers.splice(aRow, 1);

      // Now invalidate the correct tree rows.
      this.mRowCount--;
      this.tree.rowCountChanged(aRow, -1);

      // Now update the selection position, unless noSelect (selection is
      // done later or not at all).  If the item is the last child, select the
      // parent.  Otherwise select the next sibling.
      if (!aNoSelect) {
        if (aRow <= FeedSubscriptions.mFeedContainers.length) {
          this.selection.select(hasNextSibling ? aRow : aRow - 1);
        } else {
          this.selection.clearSelection();
        }
      }

      // Now refocus the tree.
      FeedSubscriptions.mTree.focus();
    },

    getCellText(aRow, aColumn) {
      let item = this.getItemAtIndex(aRow);
      return item && aColumn.id == "folderNameCol" ? item.name : "";
    },

    getImageSrc(aRow, aCol) {
      let item = this.getItemAtIndex(aRow);
      if ((item.folder && item.folder.isServer) || item.open) {
        return "";
      }

      if (
        !item.open &&
        (item.properties.includes("hasError") ||
          item.properties.includes("isBusy"))
      ) {
        return "";
      }

      if (item.favicon != null) {
        return item.favicon;
      }

      if (
        item.folder &&
        FeedSubscriptions.mMainWin &&
        "gFolderTreeView" in FeedSubscriptions.mMainWin
      ) {
        let favicon = FeedSubscriptions.mMainWin.gFolderTreeView.getFolderCacheProperty(
          item.folder,
          "favicon"
        );
        if (favicon != null) {
          return (item.favicon = favicon);
        }
      }

      let callback = iconUrl => {
        item.favicon = iconUrl;
        if (item.folder) {
          for (let child of item.children) {
            if (!child.container) {
              child.favicon = iconUrl;
              break;
            }
          }
        }

        this.selection.tree.invalidateRow(aRow);
      };

      // A closed non server folder.
      if (item.folder) {
        for (let child of item.children) {
          if (!child.container) {
            if (child.favicon != null) {
              return child.favicon;
            }

            setTimeout(() => {
              FeedUtils.getFavicon(
                child.parentFolder,
                child.url,
                null,
                window,
                callback
              );
            }, 0);
            break;
          }
        }
      } else {
        // A feed.
        setTimeout(() => {
          FeedUtils.getFavicon(
            item.parentFolder,
            item.url,
            null,
            window,
            callback
          );
        }, 0);
      }

      // Store empty string to return default while favicons are retrieved.
      return (item.favicon = "");
    },

    canDrop(aRow, aOrientation) {
      let dropResult = this.extractDragData(aRow);
      return (
        aOrientation == Ci.nsITreeView.DROP_ON &&
        dropResult.canDrop &&
        (dropResult.dropUrl ||
          dropResult.dropOnIndex != this.kRowIndexUndefined)
      );
    },

    drop(aRow, aOrientation) {
      let win = FeedSubscriptions;
      let results = this.extractDragData(aRow);
      if (!results.canDrop) {
        return;
      }

      // Preselect the drop folder.
      this.selection.select(aRow);

      if (results.dropUrl) {
        // Don't freeze the app that initiated the drop just because we are
        // in a loop waiting for the user to dimisss the add feed dialog.
        setTimeout(() => {
          win.addFeed(results.dropUrl, null, true, null, win.kSubscribeMode);
        }, 0);

        let folderItem = this.getItemAtIndex(aRow);
        FeedUtils.log.debug(
          "drop: folder, url - " +
            folderItem.folder.name +
            ", " +
            results.dropUrl
        );
      } else if (results.dropOnIndex != this.kRowIndexUndefined) {
        win.moveCopyFeed(results.dropOnIndex, aRow, results.dropEffect);
      }
    },

    // Helper function for drag and drop.
    extractDragData(aRow) {
      let dt = this._currentDataTransfer;
      let dragDataResults = {
        canDrop: false,
        dropUrl: null,
        dropOnIndex: this.kRowIndexUndefined,
        dropEffect: dt.dropEffect,
      };

      if (dt.getData("text/x-moz-feed-index")) {
        // Dragging a feed in the tree.
        if (this.selection) {
          dragDataResults.dropOnIndex = this.selection.currentIndex;

          let curItem = this.getItemAtIndex(this.selection.currentIndex);
          let newItem = this.getItemAtIndex(aRow);
          let curServer =
            curItem && curItem.parentFolder
              ? curItem.parentFolder.server
              : null;
          let newServer =
            newItem && newItem.folder ? newItem.folder.server : null;

          // No copying within the same account and no moving to the account
          // folder in the same account.
          if (
            !(
              curServer == newServer &&
              (dragDataResults.dropEffect == "copy" ||
                newItem.folder == curItem.parentFolder ||
                newItem.folder.isServer)
            )
          ) {
            dragDataResults.canDrop = true;
          }
        }
      } else {
        // Try to get a feed url.
        let validUri = FeedUtils.getFeedUriFromDataTransfer(dt);

        if (validUri) {
          dragDataResults.canDrop = true;
          dragDataResults.dropUrl = validUri.spec;
        }
      }

      return dragDataResults;
    },

    getParentIndex(aRow) {
      let item = this.getItemAtIndex(aRow);

      if (item) {
        for (let index = aRow; index >= 0; index--) {
          if (FeedSubscriptions.mFeedContainers[index].level < item.level) {
            return index;
          }
        }
      }

      return this.kRowIndexUndefined;
    },

    isIndexChildOfParentIndex(aRow, aChildRow) {
      // For visible tree rows, not if items are children of closed folders.
      let item = this.getItemAtIndex(aRow);
      if (!item || aChildRow <= aRow) {
        return false;
      }

      let targetLevel = this.getItemAtIndex(aRow).level;
      let rows = FeedSubscriptions.mFeedContainers;

      for (let i = aRow + 1; i < rows.length; i++) {
        if (this.getItemAtIndex(i).level <= targetLevel) {
          break;
        }
        if (aChildRow == i) {
          return true;
        }
      }

      return false;
    },

    hasNextSibling(aRow, aAfterIndex) {
      let targetLevel = this.getItemAtIndex(aRow).level;
      let rows = FeedSubscriptions.mFeedContainers;
      for (let i = aAfterIndex + 1; i < rows.length; i++) {
        if (this.getItemAtIndex(i).level == targetLevel) {
          return true;
        }
        if (this.getItemAtIndex(i).level < targetLevel) {
          return false;
        }
      }

      return false;
    },

    hasPreviousSibling(aRow) {
      let item = this.getItemAtIndex(aRow);
      if (item && aRow) {
        return this.getItemAtIndex(aRow - 1).level == item.level;
      }

      return false;
    },

    getLevel(aRow) {
      let item = this.getItemAtIndex(aRow);
      if (!item) {
        return 0;
      }

      return item.level;
    },

    toggleOpenState(aRow) {
      let item = this.getItemAtIndex(aRow);
      if (!item) {
        return;
      }

      // Save off the current selection item.
      let seln = this.selection;
      let currentSelectionIndex = seln.currentIndex;

      let rowsChanged = this.toggle(aRow);

      // Now restore selection, ensuring selection is maintained on toggles.
      if (currentSelectionIndex > aRow) {
        seln.currentIndex = currentSelectionIndex + rowsChanged;
      } else {
        seln.select(currentSelectionIndex);
      }

      seln.selectEventsSuppressed = false;
    },

    toggle(aRow) {
      // Collapse the row, or build sub rows based on open states in the map.
      let item = this.getItemAtIndex(aRow);
      if (!item) {
        return null;
      }

      let rows = FeedSubscriptions.mFeedContainers;
      let rowCount = 0;
      let multiplier;

      function addDescendants(aItem) {
        for (let i = 0; i < aItem.children.length; i++) {
          rowCount++;
          let child = aItem.children[i];
          rows.splice(aRow + rowCount, 0, child);
          if (child.open) {
            addDescendants(child);
          }
        }
      }

      if (item.open) {
        // Close the container.  Add up all subfolders and their descendants
        // who may be open.
        multiplier = -1;
        let nextRow = aRow + 1;
        let nextItem = rows[nextRow];
        while (nextItem && nextItem.level > item.level) {
          rowCount++;
          nextItem = rows[++nextRow];
        }

        rows.splice(aRow + 1, rowCount);
      } else {
        // Open the container.  Restore the open state of all subfolder and
        // their descendants.
        multiplier = 1;
        addDescendants(item);
      }

      let delta = multiplier * rowCount;
      this.mRowCount += delta;

      item.open = !item.open;
      // Suppress the select event caused by rowCountChanged.
      this.selection.selectEventsSuppressed = true;
      // Add or remove the children from our view.
      this.tree.rowCountChanged(aRow, delta);
      return delta;
    },
  },

  makeFolderObject(aFolder, aCurrentLevel) {
    let defaultQuickMode = aFolder.server.getBoolValue("quickMode");
    let optionsAcct = aFolder.isServer
      ? FeedUtils.getOptionsAcct(aFolder.server)
      : null;
    let open =
      !aFolder.isServer &&
      aFolder.server == this.mRSSServer &&
      this.mActionMode == this.kImportingOPML;
    let folderObject = {
      children: [],
      folder: aFolder,
      name: aFolder.prettyName,
      level: aCurrentLevel,
      url: aFolder.URI,
      quickMode: defaultQuickMode,
      options: optionsAcct,
      open,
      container: true,
      favicon: null,
    };

    // If a feed has any sub folders, add them to the list of children.
    for (let folder of aFolder.subFolders) {
      if (
        folder instanceof Ci.nsIMsgFolder &&
        !folder.getFlag(Ci.nsMsgFolderFlags.Trash) &&
        !folder.getFlag(Ci.nsMsgFolderFlags.Virtual)
      ) {
        folderObject.children.push(
          this.makeFolderObject(folder, aCurrentLevel + 1)
        );
      }
    }

    let feeds = this.getFeedsInFolder(aFolder);
    for (let feed of feeds) {
      // Now add any feed urls for the folder.
      folderObject.children.push(
        this.makeFeedObject(feed, aFolder, aCurrentLevel + 1)
      );
    }

    // Finally, set the folder's quickMode based on the its first feed's
    // quickMode, since that is how the view determines summary mode, and now
    // quickMode is updated to be the same for all feeds in a folder.
    if (feeds && feeds[0]) {
      folderObject.quickMode = feeds[0].quickMode;
    }

    folderObject.children = this.folderItemSorter(folderObject.children);

    return folderObject;
  },

  folderItemSorter(aArray) {
    return aArray
      .sort(function(a, b) {
        return a.name.toLowerCase() > b.name.toLowerCase();
      })
      .sort(function(a, b) {
        return a.container < b.container;
      });
  },

  getFeedsInFolder(aFolder) {
    let feeds = [];
    let feedUrlArray = FeedUtils.getFeedUrlsInFolder(aFolder);
    if (!feedUrlArray) {
      // No feedUrls in this folder.
      return feeds;
    }

    for (let url of feedUrlArray) {
      let feed = new Feed(url, aFolder);
      feeds.push(feed);
    }

    return feeds;
  },

  makeFeedObject(aFeed, aFolder, aLevel) {
    // Look inside the data source for the feed properties.
    let feed = {
      children: [],
      parentFolder: aFolder,
      name: aFeed.title || aFeed.description || aFeed.url,
      url: aFeed.url,
      quickMode: aFeed.quickMode,
      options: aFeed.options || FeedUtils.optionsTemplate,
      level: aLevel,
      open: false,
      container: false,
      favicon: null,
    };
    return feed;
  },

  loadSubscriptions() {
    // Put together an array of folders.  Each feed account level folder is
    // included as the root.
    let numFolders = 0;
    let feedContainers = [];
    // Get all the feed account folders.
    let feedRootFolders = FeedUtils.getAllRssServerRootFolders();

    feedRootFolders.forEach(function(rootFolder) {
      feedContainers.push(this.makeFolderObject(rootFolder, 0));
      numFolders++;
    }, this);

    this.mFeedContainers = feedContainers;
    this.mView.mRowCount = numFolders;

    FeedSubscriptions.mTree.focus();
  },

  /**
   * Find the folder in the tree.  The search may be limited to subfolders of
   * a known folder, or expanded to include the entire tree. This function is
   * also used to insert/remove folders without rebuilding the tree view cache
   * (to avoid position/toggle state loss).
   *
   * @param {nsIMsgFolder} aFolder - The folder to find.
   * @param {Object} aParms        - The params object, containing:
   *
   * {Integer} parentIndex    - index of folder to start the search; if
   *                            null (default), the index of the folder's
   *                            rootFolder will be used.
   * {Boolean} select         - if true (default) the folder's ancestors
   *                            will be opened and the folder selected.
   * {Boolean} open           - if true (default) the folder is opened.
   * {Boolean} remove         - delete the item from tree row cache if true,
   *                            false (default) otherwise.
   * {nsIMsgFolder} newFolder - if not null (default) the new folder,
   *                            for add or rename.
   *
   * @returns {Boolean} found - true if found, false if not.
   */
  selectFolder(aFolder, aParms) {
    let folderURI = aFolder.URI;
    let parentIndex =
      aParms && "parentIndex" in aParms ? aParms.parentIndex : null;
    let selectIt = aParms && "select" in aParms ? aParms.select : true;
    let openIt = aParms && "open" in aParms ? aParms.open : true;
    let removeIt = aParms && "remove" in aParms ? aParms.remove : false;
    let newFolder = aParms && "newFolder" in aParms ? aParms.newFolder : null;
    let startIndex, startItem;
    let found = false;

    let firstVisRow, curFirstVisRow, curLastVisRow;
    if (this.mView.tree) {
      firstVisRow = this.mView.tree.getFirstVisibleRow();
    }

    if (parentIndex != null) {
      // Use the parentIndex if given.
      startIndex = parentIndex;
      if (aFolder.isServer) {
        // Fake item for account root folder.
        startItem = {
          name: "AccountRoot",
          children: [this.mView.getItemAtIndex(startIndex)],
          container: true,
          open: false,
          url: null,
          level: -1,
        };
      } else {
        startItem = this.mView.getItemAtIndex(startIndex);
      }
    } else {
      // Get the folder's root parent index.
      let index = 0;
      for (index; index < this.mView.rowCount; index++) {
        let item = this.mView.getItemAtIndex(index);
        if (item.url == aFolder.server.rootFolder.URI) {
          break;
        }
      }

      startIndex = index;
      if (aFolder.isServer) {
        // Fake item for account root folder.
        startItem = {
          name: "AccountRoot",
          children: [this.mView.getItemAtIndex(startIndex)],
          container: true,
          open: false,
          url: null,
          level: -1,
        };
      } else {
        startItem = this.mView.getItemAtIndex(startIndex);
      }
    }

    function containsFolder(aItem) {
      // Search for the folder.  If it's found, set the open state on all
      // ancestor folders.  A toggle() rebuilds the view rows to match the map.
      if (aItem.url == folderURI) {
        return (found = true);
      }

      for (let i = 0; i < aItem.children.length; i++) {
        if (aItem.children[i].container && containsFolder(aItem.children[i])) {
          if (removeIt && aItem.children[i].url == folderURI) {
            // Get all occurrences in the tree cache arrays.
            FeedUtils.log.debug(
              "selectFolder: delete in cache, " +
                "parent:children:item:index - " +
                aItem.name +
                ":" +
                aItem.children.length +
                ":" +
                aItem.children[i].name +
                ":" +
                i
            );
            aItem.children.splice(i, 1);
            FeedUtils.log.debug(
              "selectFolder: deleted in cache, " +
                "parent:children - " +
                aItem.name +
                ":" +
                aItem.children.length
            );
            removeIt = false;
            return true;
          }
          if (newFolder) {
            let newItem = FeedSubscriptions.makeFolderObject(
              newFolder,
              aItem.level + 1
            );
            newItem.open = aItem.children[i].open;
            if (newFolder.isServer) {
              FeedSubscriptions.mFeedContainers[startIndex] = newItem;
            } else {
              aItem.children[i] = newItem;
              aItem.children = FeedSubscriptions.folderItemSorter(
                aItem.children
              );
            }
            FeedUtils.log.trace(
              "selectFolder: parentName:newFolderName:newFolderItem - " +
                aItem.name +
                ":" +
                newItem.name +
                ":" +
                newItem.toSource()
            );
            newFolder = null;
            return true;
          }
          if (!found) {
            // For the folder to find.
            found = true;
            aItem.children[i].open = openIt;
          } else if (selectIt || openIt) {
            // For ancestor folders.
            aItem.children[i].open = true;
          }

          return true;
        }
      }

      return false;
    }

    if (startItem) {
      // Find a folder with a specific parent.
      containsFolder(startItem);
      if (!found) {
        return false;
      }

      if (!selectIt) {
        return true;
      }

      if (startItem.open) {
        this.mView.toggle(startIndex);
      }

      this.mView.toggleOpenState(startIndex);
    }

    for (let index = 0; index < this.mView.rowCount && selectIt; index++) {
      // The desired folder is now in the view.
      let item = this.mView.getItemAtIndex(index);
      if (!item.container) {
        continue;
      }

      if (item.url == folderURI) {
        if (
          item.children.length &&
          ((!item.open && openIt) || (item.open && !openIt))
        ) {
          this.mView.toggleOpenState(index);
        }

        this.mView.selection.select(index);
        found = true;
        break;
      }
    }

    // Ensure tree position does not jump unnecessarily.
    curFirstVisRow = this.mView.tree.getFirstVisibleRow();
    curLastVisRow = this.mView.tree.getLastVisibleRow();
    if (
      firstVisRow >= 0 &&
      this.mView.rowCount - curLastVisRow > firstVisRow - curFirstVisRow
    ) {
      this.mView.tree.scrollToRow(firstVisRow);
    } else {
      this.mView.tree.ensureRowIsVisible(this.mView.rowCount - 1);
    }

    FeedUtils.log.debug(
      "selectFolder: curIndex:firstVisRow:" +
        "curFirstVisRow:curLastVisRow:rowCount - " +
        this.mView.selection.currentIndex +
        ":" +
        firstVisRow +
        ":" +
        curFirstVisRow +
        ":" +
        curLastVisRow +
        ":" +
        this.mView.rowCount
    );
    return found;
  },

  /**
   * Find the feed in the tree.  The search first gets the feed's folder,
   * then selects the child feed.
   *
   * @param {Feed} aFeed           - The feed to find.
   * @param {Integer} aParentIndex - Index to start the folder search.
   *
   * @returns {Boolean} found - true if found, false if not.
   */
  selectFeed(aFeed, aParentIndex) {
    let folder = aFeed.folder;
    let server = aFeed.server || aFeed.folder.server;
    let found = false;

    if (aFeed.folder.isServer) {
      // If passed the root folder, the caller wants to get the feed's folder
      // from the db (for cases of an ancestor folder rename/move).
      let destFolder = FeedUtils.getSubscriptionAttr(
        aFeed.url,
        server,
        "destFolder"
      );
      folder = server.rootFolder.getChildWithURI(destFolder, true, false);
    }

    if (this.selectFolder(folder, { parentIndex: aParentIndex })) {
      let seln = this.mView.selection;
      let item = this.mView.currentItem;
      if (item) {
        for (let i = seln.currentIndex + 1; i < this.mView.rowCount; i++) {
          if (this.mView.getItemAtIndex(i).url == aFeed.url) {
            this.mView.selection.select(i);
            this.mView.tree.ensureRowIsVisible(i);
            found = true;
            break;
          }
        }
      }
    }

    return found;
  },

  updateFeedData(aItem) {
    if (!aItem) {
      return;
    }

    let nameValue = document.getElementById("nameValue");
    let locationValue = document.getElementById("locationValue");
    let locationValidate = document.getElementById("locationValidate");
    let isServer = aItem.folder && aItem.folder.isServer;
    let isFolder = aItem.folder && !aItem.folder.isServer;
    let isFeed = !aItem.container;
    let server, displayFolder;

    if (isFeed) {
      // A feed item.  Set the feed location and title info.
      nameValue.value = aItem.name;
      locationValue.value = aItem.url;
      locationValidate.removeAttribute("collapsed");

      // Root the location picker to the news & blogs server.
      server = aItem.parentFolder.server;
      displayFolder = aItem.parentFolder;
    } else {
      // A folder/container item.
      nameValue.value = "";
      nameValue.disabled = true;
      locationValue.value = "";
      locationValidate.setAttribute("collapsed", true);

      server = aItem.folder.server;
      displayFolder = aItem.folder;
    }

    // Common to both folder and feed items.
    nameValue.disabled = aItem.container;
    this.setFolderPicker(displayFolder, isFeed);

    // Set quick mode value.
    document.getElementById("quickMode").checked = aItem.quickMode;

    if (isServer) {
      aItem.options = FeedUtils.getOptionsAcct(server);
    }

    // Update items.
    let updateEnabled = document.getElementById("updateEnabled");
    let updateValue = document.getElementById("updateValue");
    let biffUnits = document.getElementById("biffUnits");
    let recommendedUnits = document.getElementById("recommendedUnits");
    let recommendedUnitsVal = document.getElementById("recommendedUnitsVal");
    let updates = aItem.options
      ? aItem.options.updates
      : FeedUtils._optionsDefault.updates;

    updateEnabled.checked = updates.enabled;
    updateValue.disabled = !updateEnabled.checked || isFolder;
    biffUnits.disabled = !updateEnabled.checked || isFolder;
    biffUnits.value = updates.updateUnits;
    let minutes =
      updates.updateUnits == FeedUtils.kBiffUnitsMinutes
        ? updates.updateMinutes
        : updates.updateMinutes / (24 * 60);
    updateValue.value = Number(minutes);
    if (isFeed) {
      recommendedUnitsVal.value = this.getUpdateMinutesRec(updates);
    } else {
      recommendedUnitsVal.value = "";
    }

    let hideRec = recommendedUnitsVal.value == "";
    recommendedUnits.hidden = hideRec;
    recommendedUnitsVal.hidden = hideRec;

    // Autotag items.
    let autotagEnable = document.getElementById("autotagEnable");
    let autotagUsePrefix = document.getElementById("autotagUsePrefix");
    let autotagPrefix = document.getElementById("autotagPrefix");
    let category = aItem.options ? aItem.options.category : null;

    autotagEnable.checked = category && category.enabled;
    autotagUsePrefix.checked = category && category.prefixEnabled;
    autotagUsePrefix.disabled = !autotagEnable.checked;
    autotagPrefix.disabled =
      autotagUsePrefix.disabled || !autotagUsePrefix.checked;
    autotagPrefix.value = category && category.prefix ? category.prefix : "";
  },

  setFolderPicker(aFolder, aIsFeed) {
    let folderPrettyPath = FeedUtils.getFolderPrettyPath(aFolder);
    if (!folderPrettyPath) {
      return;
    }

    let selectFolder = document.getElementById("selectFolder");
    let selectFolderPopup = document.getElementById("selectFolderPopup");
    let selectFolderValue = document.getElementById("selectFolderValue");

    selectFolder.setAttribute("hidden", !aIsFeed);
    selectFolder._folder = aFolder;
    selectFolderValue.toggleAttribute("hidden", aIsFeed);
    selectFolderValue.setAttribute("showfilepath", false);

    if (aIsFeed) {
      selectFolderPopup._ensureInitialized();
      selectFolderPopup.selectFolder(aFolder);
      selectFolder.setAttribute("label", folderPrettyPath);
      selectFolder.setAttribute("uri", aFolder.URI);
    } else {
      selectFolderValue.value = folderPrettyPath;
      selectFolderValue.setAttribute("prettypath", folderPrettyPath);
      selectFolderValue.setAttribute("filepath", aFolder.filePath.path);
    }
  },

  onClickSelectFolderValue(aEvent) {
    let target = aEvent.target;
    if (
      ("button" in aEvent &&
        (aEvent.button != 0 ||
          aEvent.originalTarget.localName != "div" ||
          target.selectionStart != target.selectionEnd)) ||
      (aEvent.keyCode && aEvent.keyCode != aEvent.DOM_VK_RETURN)
    ) {
      return;
    }

    // Toggle between showing prettyPath and absolute filePath.
    if (target.getAttribute("showfilepath") == "true") {
      target.setAttribute("showfilepath", false);
      target.value = target.getAttribute("prettypath");
    } else {
      target.setAttribute("showfilepath", true);
      target.value = target.getAttribute("filepath");
    }
  },

  /**
   * The user changed the folder for storing the feed.
   *
   * @param {Event} aEvent - Event.
   * @returns {void}
   */
  setNewFolder(aEvent) {
    aEvent.stopPropagation();
    this.setFolderPicker(aEvent.target._folder, true);

    let seln = this.mView.selection;
    if (seln.count != 1) {
      return;
    }

    let item = this.mView.getItemAtIndex(seln.currentIndex);
    if (!item || item.container || !item.parentFolder) {
      return;
    }

    let selectFolder = document.getElementById("selectFolder");
    let editFolderURI = selectFolder.getAttribute("uri");
    if (item.parentFolder.URI == editFolderURI) {
      return;
    }

    let feed = new Feed(item.url, item.parentFolder);

    // Make sure the new folderpicked folder is visible.
    this.selectFolder(selectFolder._folder);
    // Now go back to the feed item.
    this.selectFeed(feed, null);
    // We need to find the index of the new parent folder.
    let newParentIndex = this.mView.kRowIndexUndefined;
    for (let index = 0; index < this.mView.rowCount; index++) {
      let item = this.mView.getItemAtIndex(index);
      if (item && item.container && item.url == editFolderURI) {
        newParentIndex = index;
        break;
      }
    }

    if (newParentIndex != this.mView.kRowIndexUndefined) {
      this.moveCopyFeed(seln.currentIndex, newParentIndex, "move");
    }
  },

  setSummary(aChecked) {
    let item = this.mView.currentItem;
    if (!item || !item.folder) {
      // Not a folder.
      return;
    }

    if (item.folder.isServer) {
      if (document.getElementById("locationValue").value) {
        // Intent is to add a feed/folder to the account, so return.
        return;
      }

      // An account folder.  If it changes, all non feed containing subfolders
      // need to be updated with the new default.
      item.folder.server.setBoolValue("quickMode", aChecked);
      this.FolderListener.folderAdded(item.folder);
    } else if (!FeedUtils.getFeedUrlsInFolder(item.folder)) {
      // Not a folder with feeds.
      return;
    } else {
      let feedsInFolder = this.getFeedsInFolder(item.folder);
      // Update the feeds database, for each feed in the folder.
      feedsInFolder.forEach(function(feed) {
        feed.quickMode = aChecked;
      });
      // Update the folder's feeds properties in the tree map.
      item.children.forEach(function(feed) {
        feed.quickMode = aChecked;
      });
    }

    // Update the folder in the tree map.
    item.quickMode = aChecked;
    let message = FeedUtils.strings.GetStringFromName("subscribe-feedUpdated");
    this.updateStatusItem("statusText", message);
  },

  setPrefs(aNode) {
    let item = this.mView.currentItem;
    if (!item) {
      return;
    }

    let isServer = item.folder && item.folder.isServer;
    let isFolder = item.folder && !item.folder.isServer;
    let updateEnabled = document.getElementById("updateEnabled");
    let updateValue = document.getElementById("updateValue");
    let biffUnits = document.getElementById("biffUnits");
    let autotagEnable = document.getElementById("autotagEnable");
    let autotagUsePrefix = document.getElementById("autotagUsePrefix");
    let autotagPrefix = document.getElementById("autotagPrefix");
    if (
      isFolder ||
      (isServer && document.getElementById("locationValue").value)
    ) {
      // Intend to subscribe a feed to a folder, a value must be in the url
      // field. Update states for addFeed() and return.
      updateValue.disabled = !updateEnabled.checked;
      biffUnits.disabled = !updateEnabled.checked;
      autotagUsePrefix.disabled = !autotagEnable.checked;
      autotagPrefix.disabled =
        autotagUsePrefix.disabled || !autotagUsePrefix.checked;
      return;
    }

    switch (aNode.id) {
      case "nameValue":
        // Check to see if the title value changed, no blank title allowed.
        if (!aNode.value) {
          aNode.value = item.name;
          return;
        }

        item.name = aNode.value;
        let seln = this.mView.selection;
        seln.tree.invalidateRow(seln.currentIndex);
        break;
      case "locationValue":
        let updateFeedButton = document.getElementById("updateFeed");
        // Change label based on whether feed url has beed edited.
        updateFeedButton.label =
          aNode.value == item.url
            ? updateFeedButton.getAttribute("verifylabel")
            : updateFeedButton.getAttribute("updatelabel");
        updateFeedButton.setAttribute(
          "accesskey",
          aNode.value == item.url
            ? updateFeedButton.getAttribute("verifyaccesskey")
            : updateFeedButton.getAttribute("updateaccesskey")
        );
        // Disable the Update button if no feed url value is entered.
        updateFeedButton.disabled = !aNode.value;
        return;
      case "updateEnabled":
      case "updateValue":
      case "biffUnits":
        item.options.updates.enabled = updateEnabled.checked;
        let minutes =
          biffUnits.value == FeedUtils.kBiffUnitsMinutes
            ? updateValue.value
            : updateValue.value * 24 * 60;
        item.options.updates.updateMinutes = Number(minutes);
        item.options.updates.updateUnits = biffUnits.value;
        break;
      case "autotagEnable":
        item.options.category.enabled = aNode.checked;
        break;
      case "autotagUsePrefix":
        item.options.category.prefixEnabled = aNode.checked;
        item.options.category.prefix = autotagPrefix.value;
        break;
      case "autotagPrefix":
        item.options.category.prefix = aNode.value;
        break;
    }

    if (isServer) {
      FeedUtils.setOptionsAcct(item.folder.server, item.options);
    } else {
      let feed = new Feed(item.url, item.parentFolder);
      feed.title = item.name;
      feed.options = item.options;

      if (aNode.id == "updateEnabled") {
        FeedUtils.setStatus(
          item.parentFolder,
          item.url,
          "enabled",
          aNode.checked
        );
        this.mView.selection.tree.invalidateRow(
          this.mView.selection.currentIndex
        );
      }
      if (aNode.id == "updateValue") {
        FeedUtils.setStatus(
          item.parentFolder,
          item.url,
          "updateMinutes",
          item.options.updates.updateMinutes
        );
      }
    }

    this.updateFeedData(item);
    let message = FeedUtils.strings.GetStringFromName("subscribe-feedUpdated");
    this.updateStatusItem("statusText", message);
  },

  getUpdateMinutesRec(aUpdates) {
    // Assume the parser has stored correct/valid values for the spec. If the
    // feed doesn't use any of these tags, updatePeriod will be null.
    if (aUpdates.updatePeriod == null) {
      return "";
    }

    let biffUnits = document.getElementById("biffUnits").value;
    let units = biffUnits == FeedUtils.kBiffUnitsDays ? 1 : 24 * 60;
    let frequency = aUpdates.updateFrequency;
    let val;
    switch (aUpdates.updatePeriod) {
      case "hourly":
        val =
          biffUnits == FeedUtils.kBiffUnitsDays
            ? 1 / frequency / 24
            : 60 / frequency;
        break;
      case "daily":
        val = units / frequency;
        break;
      case "weekly":
        val = (7 * units) / frequency;
        break;
      case "monthly":
        val = (30 * units) / frequency;
        break;
      case "yearly":
        val = (365 * units) / frequency;
        break;
    }

    return val ? Math.round(val * 1000) / 1000 : "";
  },

  onKeyPress(aEvent) {
    if (
      aEvent.keyCode == aEvent.DOM_VK_DELETE &&
      aEvent.target.id == "rssSubscriptionsList"
    ) {
      this.removeFeed(true);
    }

    this.clearStatusInfo();
  },

  onSelect() {
    let item = this.mView.currentItem;
    this.updateFeedData(item);
    this.setFocus();
    this.updateButtons(item);
  },

  updateButtons(aSelectedItem) {
    let item = aSelectedItem;
    let isServer = item && item.folder && item.folder.isServer;
    let isFeed = item && !item.container;
    document.getElementById("addFeed").hidden = !item || isFeed;
    document.getElementById("updateFeed").hidden = !isFeed;
    document.getElementById("removeFeed").hidden = !isFeed;
    document.getElementById("importOPML").hidden = !isServer;
    document.getElementById("exportOPML").hidden = !isServer;

    document.getElementById("importOPML").disabled = document.getElementById(
      "exportOPML"
    ).disabled = this.mActionMode == this.kImportingOPML;
  },

  onMouseDown(aEvent) {
    if (
      aEvent.button != 0 ||
      aEvent.target.id == "validationText" ||
      aEvent.target.id == "addCertException"
    ) {
      return;
    }

    this.clearStatusInfo();
  },

  onFocusChange() {
    setTimeout(() => {
      this.setFocus();
    }, 0);
  },

  setFocus() {
    let item = this.mView.currentItem;
    if (!item || this.mActionMode == this.kImportingOPML) {
      return;
    }

    let locationValue = document.getElementById("locationValue");
    let updateEnabled = document.getElementById("updateEnabled");

    let quickMode = document.getElementById("quickMode");
    let autotagEnable = document.getElementById("autotagEnable");
    let autotagUsePrefix = document.getElementById("autotagUsePrefix");
    let autotagPrefix = document.getElementById("autotagPrefix");

    let addFeedButton = document.getElementById("addFeed");
    let updateFeedButton = document.getElementById("updateFeed");

    let isServer = item.folder && item.folder.isServer;
    let isFolder = item.folder && !item.folder.isServer;

    // Enabled by default.
    updateEnabled.disabled = quickMode.disabled = autotagEnable.disabled = false;

    updateEnabled.parentNode
      .querySelectorAll("input,radio,label")
      .forEach(item => {
        item.disabled = !updateEnabled.checked;
      });

    autotagUsePrefix.disabled = !autotagEnable.checked;
    autotagPrefix.disabled =
      autotagUsePrefix.disabled || !autotagUsePrefix.checked;

    let focusedElement = window.document.commandDispatcher.focusedElement;

    if (isServer) {
      addFeedButton.disabled =
        addFeedButton != focusedElement &&
        locationValue != document.activeElement &&
        !locationValue.value;
    } else if (isFolder) {
      let disable =
        locationValue != document.activeElement && !locationValue.value;
      // Summary is enabled for a folder with feeds or if adding a feed.
      quickMode.disabled =
        disable && !FeedUtils.getFeedUrlsInFolder(item.folder);
      // All other options disabled unless intent is to add a feed.
      updateEnabled.disabled = disable;
      updateEnabled.parentNode
        .querySelectorAll("input,radio,label")
        .forEach(item => {
          item.disabled = disable;
        });

      autotagEnable.disabled = disable;

      addFeedButton.disabled =
        addFeedButton != focusedElement &&
        locationValue != document.activeElement &&
        !locationValue.value;
    } else {
      // Summary is disabled; applied per folder to apply to all feeds in it.
      quickMode.disabled = true;
      // Ensure the current feed url is restored if the user did not update.
      if (
        locationValue.value != item.url &&
        locationValue != document.activeElement &&
        focusedElement != updateFeedButton &&
        focusedElement.id != "addCertException"
      ) {
        locationValue.value = item.url;
      }
      this.setPrefs(locationValue);
      // Set button state.
      updateFeedButton.disabled = !locationValue.value;
    }
  },

  removeFeed(aPrompt) {
    let seln = this.mView.selection;
    if (seln.count != 1) {
      return;
    }

    let itemToRemove = this.mView.getItemAtIndex(seln.currentIndex);

    if (!itemToRemove || itemToRemove.container) {
      return;
    }

    if (aPrompt) {
      // Confirm unsubscribe prompt.
      let pTitle = FeedUtils.strings.GetStringFromName(
        "subscribe-confirmFeedDeletionTitle"
      );
      let pMessage = FeedUtils.strings.formatStringFromName(
        "subscribe-confirmFeedDeletion",
        [itemToRemove.name]
      );
      if (
        Services.prompt.confirmEx(
          window,
          pTitle,
          pMessage,
          Ci.nsIPromptService.STD_YES_NO_BUTTONS,
          null,
          null,
          null,
          null,
          {}
        )
      ) {
        return;
      }
    }

    let feed = new Feed(itemToRemove.url, itemToRemove.parentFolder);
    FeedUtils.deleteFeed(feed);

    // Now that we have removed the feed from the datasource, it is time to
    // update our view layer.  Update parent folder's quickMode if necessary
    // and remove the child from its parent folder object.
    let parentIndex = this.mView.getParentIndex(seln.currentIndex);
    let parentItem = this.mView.getItemAtIndex(parentIndex);
    this.updateFolderQuickModeInView(itemToRemove, parentItem, true);
    this.mView.removeItemAtIndex(seln.currentIndex, false);
    let message = FeedUtils.strings.GetStringFromName("subscribe-feedRemoved");
    this.updateStatusItem("statusText", message);
  },

  /**
   * This addFeed is used by 1) Add button, 1) Update button, 3) Drop of a
   * feed url on a folder (which can be an add or move).  If Update, the new
   * url is added and the old removed; thus aParse is false and no new messages
   * are downloaded, the feed is only validated and stored in the db.  If dnd,
   * the drop folder is selected and the url is prefilled, so proceed just as
   * though the url were entered manually.  This allows a user to see the dnd
   * url better in case of errors.
   *
   * @param {String} aFeedLocation     - the feed url; get the url from the
   *                                     input field if null.
   * @param {nsIMsgFolder} aFolder     - folder to subscribe, current selected
   *                                     folder if null.
   * @param {Boolean} aParse           - if true (default) parse and download
   *                                     the feed's articles.
   * @param {Object} aParams           - additional params.
   * @param {Integer} aMode            - action mode (default is kSubscribeMode)
   *                                     of the add.
   *
   * @returns {Boolean} success        - true if edit checks passed and an
   *                                     async download has been initiated.
   */
  addFeed(aFeedLocation, aFolder, aParse, aParams, aMode) {
    let message;
    let parse = aParse == null ? true : aParse;
    let mode = aMode == null ? this.kSubscribeMode : aMode;
    let locationValue = document.getElementById("locationValue");
    let quickMode =
      aParams && "quickMode" in aParams
        ? aParams.quickMode
        : document.getElementById("quickMode").checked;
    let name =
      aParams && "name" in aParams
        ? aParams.name
        : document.getElementById("nameValue").value;
    let options = aParams && "options" in aParams ? aParams.options : null;

    if (aFeedLocation) {
      locationValue.value = aFeedLocation;
    }
    let feedLocation = locationValue.value.trim();

    if (!feedLocation) {
      locationValue.focus();
      message = locationValue.getAttribute("placeholder");
      this.updateStatusItem("statusText", message);
      return false;
    }

    if (!FeedUtils.isValidScheme(feedLocation)) {
      locationValue.focus();
      message = FeedUtils.strings.GetStringFromName("subscribe-feedNotValid");
      this.updateStatusItem("statusText", message);
      return false;
    }

    let addFolder;
    if (aFolder) {
      // For Update or if passed a folder.
      if (aFolder instanceof Ci.nsIMsgFolder) {
        addFolder = aFolder;
      }
    } else {
      // A folder must be selected for Add and Drop.
      let index = this.mView.selection.currentIndex;
      let item = this.mView.getItemAtIndex(index);
      if (item && item.container) {
        addFolder = item.folder;
      }
    }

    // Shouldn't happen.  Or else not passed an nsIMsgFolder.
    if (!addFolder) {
      return false;
    }

    // Before we go any further, make sure the user is not already subscribed
    // to this feed.
    if (FeedUtils.feedAlreadyExists(feedLocation, addFolder.server)) {
      locationValue.focus();
      message = FeedUtils.strings.GetStringFromName(
        "subscribe-feedAlreadySubscribed"
      );
      this.updateStatusItem("statusText", message);
      return false;
    }

    if (!options) {
      // Not passed a param, get values from the ui.
      options = FeedUtils.optionsTemplate;
      options.updates.enabled = document.getElementById(
        "updateEnabled"
      ).checked;
      let biffUnits = document.getElementById("biffUnits").value;
      let units = document.getElementById("updateValue").value;
      let minutes =
        biffUnits == FeedUtils.kBiffUnitsMinutes ? units : units * 24 * 60;
      options.updates.updateUnits = biffUnits;
      options.updates.updateMinutes = Number(minutes);
      options.category.enabled = document.getElementById(
        "autotagEnable"
      ).checked;
      options.category.prefixEnabled = document.getElementById(
        "autotagUsePrefix"
      ).checked;
      options.category.prefix = document.getElementById("autotagPrefix").value;
    }

    let feedProperties = {
      feedName: name,
      feedLocation,
      feedFolder: addFolder,
      quickMode,
      options,
    };

    let feed = this.storeFeed(feedProperties);
    if (!feed) {
      return false;
    }

    // Now validate and start downloading the feed.
    message = FeedUtils.strings.GetStringFromName("subscribe-validating-feed");
    this.updateStatusItem("statusText", message);
    this.updateStatusItem("progressMeter", "?");
    document.getElementById("addFeed").disabled = true;
    this.mActionMode = mode;
    feed.download(parse, this.mFeedDownloadCallback);
    return true;
  },

  // Helper routine used by addFeed and importOPMLFile.
  storeFeed(feedProperties) {
    let feed = new Feed(feedProperties.feedLocation, feedProperties.feedFolder);
    feed.title = feedProperties.feedName;
    feed.quickMode = feedProperties.quickMode;
    feed.options = feedProperties.options;
    return feed;
  },

  /**
   * When a feed item is selected, the Update button is used to verify the
   * existing feed url, or to verify and update the feed url if the field
   * has been edited. This is the only use of the Update button.
   *
   * @returns {void}
   */
  updateFeed() {
    let seln = this.mView.selection;
    if (seln.count != 1) {
      return;
    }

    let item = this.mView.getItemAtIndex(seln.currentIndex);
    if (!item || item.container || !item.parentFolder) {
      return;
    }

    let feed = new Feed(item.url, item.parentFolder);

    // Disable the button.
    document.getElementById("updateFeed").disabled = true;

    let feedLocation = document.getElementById("locationValue").value.trim();
    if (feed.url != feedLocation) {
      // Updating a url.  We need to add the new url and delete the old, to
      // ensure everything is cleaned up correctly.
      this.addFeed(null, item.parentFolder, false, null, this.kUpdateMode);
      return;
    }

    // Now we want to verify if the stored feed url still works. If it
    // doesn't, show the error.
    let message = FeedUtils.strings.GetStringFromName(
      "subscribe-validating-feed"
    );
    this.mActionMode = this.kVerifyUrlMode;
    this.updateStatusItem("statusText", message);
    this.updateStatusItem("progressMeter", "?");
    feed.download(false, this.mFeedDownloadCallback);
  },

  /**
   * Moves or copies a feed to another folder or account.
   *
   * @param {Integer} aOldFeedIndex   - Index in tree of target feed item.
   * @param {Integer} aNewParentIndex - Index in tree of target parent folder item.
   * @param {String} aMoveCopy        - Either "move" or "copy".
   *
   * @returns {void}
   */
  moveCopyFeed(aOldFeedIndex, aNewParentIndex, aMoveCopy) {
    let moveFeed = aMoveCopy == "move";
    let currentItem = this.mView.getItemAtIndex(aOldFeedIndex);
    if (
      !currentItem ||
      this.mView.getParentIndex(aOldFeedIndex) == aNewParentIndex
    ) {
      // If the new parent is the same as the current parent, then do nothing.
      return;
    }

    let currentParentIndex = this.mView.getParentIndex(aOldFeedIndex);
    let currentParentItem = this.mView.getItemAtIndex(currentParentIndex);
    let currentFolder = currentParentItem.folder;

    let newParentItem = this.mView.getItemAtIndex(aNewParentIndex);
    let newFolder = newParentItem.folder;

    let accountMoveCopy = false;
    if (currentFolder.rootFolder.URI == newFolder.rootFolder.URI) {
      // Moving within the same account/feeds db.
      if (newFolder.isServer || !moveFeed) {
        // No moving to account folder if already in the account; can only move,
        // not copy, to folder in the same account.
        return;
      }

      // Update the destFolder for this feed's subscription.
      FeedUtils.setSubscriptionAttr(
        currentItem.url,
        currentItem.parentFolder.server,
        "destFolder",
        newFolder.URI
      );

      // Update folderpane favicons.
      FeedUtils.setFolderPaneProperty(currentFolder, "favicon", null, "row");
      FeedUtils.setFolderPaneProperty(newFolder, "favicon", null, "row");
    } else {
      // Moving/copying to a new account.  If dropping on the account folder,
      // a new subfolder is created if necessary.
      accountMoveCopy = true;
      let mode = moveFeed ? this.kMoveMode : this.kCopyMode;
      let params = {
        quickMode: currentItem.quickMode,
        name: currentItem.name,
        options: currentItem.options,
      };
      // Subscribe to the new folder first.  If it already exists in the
      // account or on error, return.
      if (!this.addFeed(currentItem.url, newFolder, false, params, mode)) {
        return;
      }
      // Unsubscribe the feed from the old folder, if add to the new folder
      // is successful, and doing a move.
      if (moveFeed) {
        let feed = new Feed(currentItem.url, currentItem.parentFolder);
        FeedUtils.deleteFeed(feed);
      }
    }

    // Update local favicons.
    currentParentItem.favicon = newParentItem.favicon = null;

    // Finally, update our view layer.  Update old parent folder's quickMode
    // and remove the old row, if move.  Otherwise no change to the view.
    if (moveFeed) {
      this.updateFolderQuickModeInView(currentItem, currentParentItem, true);
      this.mView.removeItemAtIndex(aOldFeedIndex, true);
      if (aNewParentIndex > aOldFeedIndex) {
        aNewParentIndex--;
      }
    }

    if (accountMoveCopy) {
      // If a cross account move/copy, download callback will update the view
      // with the new location.  Preselect folder/mode for callback.
      this.selectFolder(newFolder, { parentIndex: aNewParentIndex });
      return;
    }

    // Add the new row location to the view.
    currentItem.level = newParentItem.level + 1;
    currentItem.parentFolder = newFolder;
    this.updateFolderQuickModeInView(currentItem, newParentItem, false);
    newParentItem.children.push(currentItem);

    if (newParentItem.open) {
      // Close the container, selecting the feed will rebuild the view rows.
      this.mView.toggle(aNewParentIndex);
    }

    this.selectFeed(
      { folder: newParentItem.folder, url: currentItem.url },
      aNewParentIndex
    );

    let message = FeedUtils.strings.GetStringFromName("subscribe-feedMoved");
    this.updateStatusItem("statusText", message);
  },

  updateFolderQuickModeInView(aFeedItem, aParentItem, aRemove) {
    let feedItem = aFeedItem;
    let parentItem = aParentItem;
    let feedUrlArray = FeedUtils.getFeedUrlsInFolder(feedItem.parentFolder);
    let feedsInFolder = feedUrlArray ? feedUrlArray.length : 0;

    if (aRemove && feedsInFolder < 1) {
      // Removed only feed in folder; set quickMode to server default.
      parentItem.quickMode = parentItem.folder.server.getBoolValue("quickMode");
    }

    if (!aRemove) {
      // Just added a feed to a folder.  If there are already feeds in the
      // folder, the feed must reflect the parent's quickMode.  If it is the
      // only feed, update the parent folder to the feed's quickMode.
      if (feedsInFolder > 1) {
        let feed = new Feed(feedItem.url, feedItem.parentFolder);
        feed.quickMode = parentItem.quickMode;
        feedItem.quickMode = parentItem.quickMode;
      } else {
        parentItem.quickMode = feedItem.quickMode;
      }
    }
  },

  onDragStart(aEvent) {
    // Get the selected feed article (if there is one).
    let seln = this.mView.selection;
    if (seln.count != 1) {
      return;
    }

    // Only initiate a drag if the item is a feed (ignore folders/containers).
    let item = this.mView.getItemAtIndex(seln.currentIndex);
    if (!item || item.container) {
      return;
    }

    aEvent.dataTransfer.setData("text/x-moz-feed-index", seln.currentIndex);
    aEvent.dataTransfer.effectAllowed = "copyMove";
  },

  onDragOver(aEvent) {
    this.mView._currentDataTransfer = aEvent.dataTransfer;
  },

  mFeedDownloadCallback: {
    mSubscribeMode: true,
    downloaded(feed, aErrorCode) {
      // Offline check is done in the context of 3pane, return to the subscribe
      // window once the modal prompt is dispatched.
      window.focus();
      // Feed is null if our attempt to parse the feed failed.
      let message = "";
      let win = FeedSubscriptions;
      if (
        aErrorCode == FeedUtils.kNewsBlogSuccess ||
        aErrorCode == FeedUtils.kNewsBlogNoNewItems
      ) {
        win.updateStatusItem("progressMeter", 100);

        if (win.mActionMode == win.kVerifyUrlMode) {
          // Just checking for errors, if none bye. The (non error) code
          // kNewsBlogNoNewItems can only happen in verify mode.
          win.mActionMode = null;
          win.clearStatusInfo();
          if (Services.io.offline) {
            return;
          }

          message = FeedUtils.strings.GetStringFromName(
            "subscribe-feedVerified"
          );
          win.updateStatusItem("statusText", message);
          return;
        }

        // Update lastUpdateTime if successful.
        let options = feed.options;
        options.updates.lastUpdateTime = Date.now();
        feed.options = options;

        // Add the feed to the databases.
        FeedUtils.addFeed(feed);

        // Now add the feed to our view.  If adding, the current selection will
        // be a folder; if updating it will be a feed.  No need to rebuild the
        // entire view, that is too jarring.
        let curIndex = win.mView.selection.currentIndex;
        let curItem = win.mView.getItemAtIndex(curIndex);
        if (curItem) {
          let parentIndex, parentItem, newItem, level;
          if (curItem.container) {
            // Open the container, if it exists.
            let folderExists = win.selectFolder(feed.folder, {
              parentIndex: curIndex,
            });
            if (!folderExists) {
              // This means a new folder was created.
              parentIndex = curIndex;
              parentItem = curItem;
              level = curItem.level + 1;
              newItem = win.makeFolderObject(feed.folder, level);
            } else {
              // If a folder happens to exist which matches one that would
              // have been created, the feed system reuses it.  Get the
              // current item again if reusing a previously unselected folder.
              curIndex = win.mView.selection.currentIndex;
              curItem = win.mView.getItemAtIndex(curIndex);
              parentIndex = curIndex;
              parentItem = curItem;
              level = curItem.level + 1;
              newItem = win.makeFeedObject(feed, feed.folder, level);
            }
          } else {
            // Adding a feed.
            parentIndex = win.mView.getParentIndex(curIndex);
            parentItem = win.mView.getItemAtIndex(parentIndex);
            level = curItem.level;
            newItem = win.makeFeedObject(feed, feed.folder, level);
          }

          if (!newItem.container) {
            win.updateFolderQuickModeInView(newItem, parentItem, false);
          }

          parentItem.children.push(newItem);
          parentItem.children = win.folderItemSorter(parentItem.children);
          parentItem.favicon = null;

          if (win.mActionMode == win.kSubscribeMode) {
            message = FeedUtils.strings.GetStringFromName(
              "subscribe-feedAdded"
            );
          }
          if (win.mActionMode == win.kUpdateMode) {
            win.removeFeed(false);
            message = FeedUtils.strings.GetStringFromName(
              "subscribe-feedUpdated"
            );
          }
          if (win.mActionMode == win.kMoveMode) {
            message = FeedUtils.strings.GetStringFromName(
              "subscribe-feedMoved"
            );
          }
          if (win.mActionMode == win.kCopyMode) {
            message = FeedUtils.strings.GetStringFromName(
              "subscribe-feedCopied"
            );
          }

          win.selectFeed(feed, parentIndex);
        }
      } else {
        // Non success.  Remove intermediate traces from the feeds database.
        // But only if we're not in verify mode.
        if (
          win.mActionMode != win.kVerifyUrlMode &&
          feed &&
          feed.url &&
          feed.server
        ) {
          FeedUtils.deleteFeed(feed);
        }

        if (aErrorCode == FeedUtils.kNewsBlogInvalidFeed) {
          message = FeedUtils.strings.GetStringFromName(
            "subscribe-feedNotValid"
          );
        }
        if (aErrorCode == FeedUtils.kNewsBlogRequestFailure) {
          message = FeedUtils.strings.GetStringFromName(
            "subscribe-networkError"
          );
        }
        if (aErrorCode == FeedUtils.kNewsBlogFileError) {
          message = FeedUtils.strings.GetStringFromName(
            "subscribe-errorOpeningFile"
          );
        }
        if (aErrorCode == FeedUtils.kNewsBlogBadCertError) {
          let host = Services.io.newURI(feed.url).host;
          message = FeedUtils.strings.formatStringFromName(
            "newsblog-badCertError",
            [host]
          );
        }
        if (aErrorCode == FeedUtils.kNewsBlogNoAuthError) {
          message = FeedUtils.strings.GetStringFromName(
            "subscribe-noAuthError"
          );
        }

        // Focus the url if verify/update failed.
        if (
          win.mActionMode == win.kUpdateMode ||
          win.mActionMode == win.kVerifyUrlMode
        ) {
          document.getElementById("locationValue").focus();
        }
      }

      win.mActionMode = null;
      win.clearStatusInfo();
      let code = feed.url.startsWith("http") ? aErrorCode : null;
      win.updateStatusItem("statusText", message, code);
    },

    // This gets called after the RSS parser finishes storing a feed item to
    // disk.  aCurrentFeedItems is an integer corresponding to how many feed
    // items have been downloaded so far.  aMaxFeedItems is an integer
    // corresponding to the total number of feed items to download.
    onFeedItemStored(feed, aCurrentFeedItems, aMaxFeedItems) {
      window.focus();
      let message = FeedUtils.strings.formatStringFromName(
        "subscribe-gettingFeedItems",
        [aCurrentFeedItems, aMaxFeedItems]
      );
      FeedSubscriptions.updateStatusItem("statusText", message);
      this.onProgress(feed, aCurrentFeedItems, aMaxFeedItems);
    },

    onProgress(feed, aProgress, aProgressMax, aLengthComputable) {
      FeedSubscriptions.updateStatusItem(
        "progressMeter",
        (aProgress * 100) / (aProgressMax || 100)
      );
    },
  },

  // Status routines.
  updateStatusItem(aID, aValue, aErrorCode) {
    let el = document.getElementById(aID);
    if (el.getAttribute("collapsed")) {
      el.removeAttribute("collapsed");
    }
    if (el.hidden) {
      el.hidden = false;
    }

    if (aID == "progressMeter") {
      if (aValue == "?") {
        el.removeAttribute("value");
      } else {
        el.value = aValue;
      }
    } else if (aID == "statusText") {
      el.textContent = aValue;
    }

    el = document.getElementById("validationText");
    if (aErrorCode == FeedUtils.kNewsBlogInvalidFeed) {
      el.removeAttribute("collapsed");
    } else {
      el.setAttribute("collapsed", true);
    }

    el = document.getElementById("addCertException");
    if (aErrorCode == FeedUtils.kNewsBlogBadCertError) {
      el.removeAttribute("collapsed");
    } else {
      el.setAttribute("collapsed", true);
    }
  },

  clearStatusInfo() {
    document.getElementById("statusText").textContent = "";
    document.getElementById("progressMeter").hidden = true;
    document.getElementById("validationText").collapsed = true;
    document.getElementById("addCertException").collapsed = true;
  },

  checkValidation(aEvent) {
    if (aEvent.button != 0) {
      return;
    }

    let validationQuery = "http://validator.w3.org/feed/check.cgi?url=";

    if (this.mMainWin) {
      let tabmail = this.mMainWin.document.getElementById("tabmail");
      if (tabmail) {
        let feedLocation = document.getElementById("locationValue").value;
        let url = validationQuery + encodeURIComponent(feedLocation);

        this.mMainWin.focus();
        this.mMainWin.openContentTab(url);
        FeedUtils.log.debug("checkValidation: query url - " + url);
      }
    }
    aEvent.stopPropagation();
  },

  addCertExceptionDialog() {
    let locationValue = document.getElementById("locationValue");
    let feedURL = locationValue.value.trim();
    let params = {
      exceptionAdded: false,
      location: feedURL,
      prefetchCert: true,
    };
    window.openDialog(
      "chrome://pippki/content/exceptionDialog.xhtml",
      "",
      "chrome,centerscreen,modal",
      params
    );
    if (params.exceptionAdded) {
      this.clearStatusInfo();
    }

    locationValue.focus();
  },

  // Listener for folder pane changes.
  FolderListener: {
    get feedWindow() {
      let subscriptionsWindow = Services.wm.getMostRecentWindow(
        "Mail:News-BlogSubscriptions"
      );
      return subscriptionsWindow ? subscriptionsWindow.FeedSubscriptions : null;
    },

    get currentSelectedIndex() {
      return this.feedWindow
        ? this.feedWindow.mView.selection.currentIndex
        : -1;
    },

    get currentSelectedItem() {
      return this.feedWindow ? this.feedWindow.mView.currentItem : null;
    },

    folderAdded(aFolder) {
      if (aFolder.server.type != "rss" || FeedUtils.isInTrash(aFolder)) {
        return;
      }

      let parentFolder = aFolder.isServer ? aFolder : aFolder.parent;
      FeedUtils.log.debug(
        "folderAdded: folder:parent - " +
          aFolder.name +
          ":" +
          (parentFolder ? parentFolder.filePath.path : "(null)")
      );

      if (!parentFolder || !this.feedWindow) {
        return;
      }

      let feedWindow = this.feedWindow;
      let curSelItem = this.currentSelectedItem;
      let firstVisRow = feedWindow.mView.tree.getFirstVisibleRow();
      let indexInView = feedWindow.mView.getItemInViewIndex(parentFolder);
      let open = indexInView != null;

      if (aFolder.isServer) {
        if (indexInView != null) {
          // Existing account root folder in the view.
          open = feedWindow.mView.getItemAtIndex(indexInView).open;
        } else {
          // Add the account root folder to the view.
          feedWindow.mFeedContainers.push(
            feedWindow.makeFolderObject(parentFolder, 0)
          );
          feedWindow.mView.mRowCount++;
          feedWindow.mTree.view = feedWindow.mView;
          feedWindow.mView.tree.scrollToRow(firstVisRow);
          return;
        }
      }

      // Rebuild the added folder's parent item in the tree row cache.
      feedWindow.selectFolder(parentFolder, {
        select: false,
        open,
        newFolder: parentFolder,
      });

      if (indexInView == null || !curSelItem) {
        // Folder isn't in the tree view, no need to update the view.
        return;
      }

      let parentIndex = feedWindow.mView.getParentIndex(indexInView);
      if (parentIndex == feedWindow.mView.kRowIndexUndefined) {
        // Root folder is its own parent.
        parentIndex = indexInView;
      }

      if (open) {
        // Close an open parent (or root) folder.
        feedWindow.mView.toggle(parentIndex);
        feedWindow.mView.toggleOpenState(parentIndex);
      }

      feedWindow.mView.tree.scrollToRow(firstVisRow);

      if (curSelItem.container) {
        feedWindow.selectFolder(curSelItem.folder, { open: curSelItem.open });
      } else {
        feedWindow.selectFeed(
          { folder: curSelItem.parentFolder, url: curSelItem.url },
          parentIndex
        );
      }
    },

    folderDeleted(aFolder) {
      if (aFolder.server.type != "rss" || FeedUtils.isInTrash(aFolder)) {
        return;
      }

      FeedUtils.log.debug("folderDeleted: folder - " + aFolder.name);
      if (!this.feedWindow) {
        return;
      }

      let feedWindow = this.feedWindow;
      let curSelIndex = this.currentSelectedIndex;
      let indexInView = feedWindow.mView.getItemInViewIndex(aFolder);
      let open = indexInView != null;

      // Delete the folder from the tree row cache.
      feedWindow.selectFolder(aFolder, {
        select: false,
        open: false,
        remove: true,
      });

      if (!open || curSelIndex < 0) {
        // Folder isn't in the tree view, no need to update the view.
        return;
      }

      let select =
        indexInView == curSelIndex ||
        feedWindow.mView.isIndexChildOfParentIndex(indexInView, curSelIndex);

      feedWindow.mView.removeItemAtIndex(indexInView, !select);
    },

    folderRenamed(aOrigFolder, aNewFolder) {
      if (aNewFolder.server.type != "rss" || FeedUtils.isInTrash(aNewFolder)) {
        return;
      }

      FeedUtils.log.debug(
        "folderRenamed: old:new - " + aOrigFolder.name + ":" + aNewFolder.name
      );
      if (!this.feedWindow) {
        return;
      }

      let feedWindow = this.feedWindow;
      let curSelIndex = this.currentSelectedIndex;
      let curSelItem = this.currentSelectedItem;
      let firstVisRow = feedWindow.mView.tree.getFirstVisibleRow();
      let indexInView = feedWindow.mView.getItemInViewIndex(aOrigFolder);
      let open = indexInView != null;

      // Rebuild the renamed folder's item in the tree row cache.
      feedWindow.selectFolder(aOrigFolder, {
        select: false,
        open,
        newFolder: aNewFolder,
      });

      if (!open || !curSelItem) {
        // Folder isn't in the tree view, no need to update the view.
        return;
      }

      let select =
        indexInView == curSelIndex ||
        feedWindow.mView.isIndexChildOfParentIndex(indexInView, curSelIndex);

      let parentIndex = feedWindow.mView.getParentIndex(indexInView);
      if (parentIndex == feedWindow.mView.kRowIndexUndefined) {
        // Root folder is its own parent.
        parentIndex = indexInView;
      }

      feedWindow.mView.toggle(parentIndex);
      feedWindow.mView.toggleOpenState(parentIndex);
      feedWindow.mView.tree.scrollToRow(firstVisRow);

      if (curSelItem.container) {
        if (curSelItem.folder == aOrigFolder) {
          feedWindow.selectFolder(aNewFolder, { open: curSelItem.open });
        } else if (select) {
          feedWindow.mView.selection.select(indexInView);
        } else {
          feedWindow.selectFolder(curSelItem.folder, { open: curSelItem.open });
        }
      } else {
        feedWindow.selectFeed(
          { folder: curSelItem.parentFolder.rootFolder, url: curSelItem.url },
          parentIndex
        );
      }
    },

    folderMoveCopyCompleted(aMove, aSrcFolder, aDestFolder) {
      if (aDestFolder.server.type != "rss") {
        return;
      }

      FeedUtils.log.debug(
        "folderMoveCopyCompleted: move:src:dest - " +
          aMove +
          ":" +
          aSrcFolder.name +
          ":" +
          aDestFolder.name
      );
      if (!this.feedWindow) {
        return;
      }

      let feedWindow = this.feedWindow;
      let curSelIndex = this.currentSelectedIndex;
      let curSelItem = this.currentSelectedItem;
      let firstVisRow = feedWindow.mView.tree.getFirstVisibleRow();
      let indexInView = feedWindow.mView.getItemInViewIndex(aSrcFolder);
      let destIndexInView = feedWindow.mView.getItemInViewIndex(aDestFolder);
      let open = indexInView != null || destIndexInView != null;
      let parentIndex = feedWindow.mView.getItemInViewIndex(
        aDestFolder.parent || aDestFolder
      );
      let select =
        indexInView == curSelIndex ||
        feedWindow.mView.isIndexChildOfParentIndex(indexInView, curSelIndex);

      if (aMove) {
        this.folderDeleted(aSrcFolder);
        if (aDestFolder.getFlag(Ci.nsMsgFolderFlags.Trash)) {
          return;
        }
      }

      setTimeout(() => {
        // State on disk needs to settle before a folder object can be rebuilt.
        feedWindow.selectFolder(aDestFolder, {
          select: false,
          open: open || select,
          newFolder: aDestFolder,
        });

        if (!open || !curSelItem) {
          // Folder isn't in the tree view, no need to update the view.
          return;
        }

        feedWindow.mView.toggle(parentIndex);
        feedWindow.mView.toggleOpenState(parentIndex);
        feedWindow.mView.tree.scrollToRow(firstVisRow);

        if (curSelItem.container) {
          if (curSelItem.folder == aSrcFolder || select) {
            feedWindow.selectFolder(aDestFolder, { open: true });
          } else {
            feedWindow.selectFolder(curSelItem.folder, {
              open: curSelItem.open,
            });
          }
        } else {
          feedWindow.selectFeed(
            { folder: curSelItem.parentFolder.rootFolder, url: curSelItem.url },
            null
          );
        }
      }, 50);
    },
  },

  /* *************************************************************** */
  /* OPML Functions                                                  */
  /* *************************************************************** */

  get brandShortName() {
    let brandBundle = document.getElementById("bundle_brand");
    return brandBundle ? brandBundle.getString("brandShortName") : "";
  },

  /**
   * Export feeds as opml file Save As filepicker function.
   *
   * @param {Boolean} aList - If true, exporting as list; if false (default)
   *                          exporting feeds in folder structure - used for title.
   * @returns {Promise} nsIFile or null.
   */
  opmlPickSaveAsFile(aList) {
    let accountName = this.mRSSServer.rootFolder.prettyName;
    let fileName = FeedUtils.strings.formatStringFromName(
      "subscribe-OPMLExportDefaultFileName",
      [this.brandShortName, accountName]
    );
    let title = aList
      ? FeedUtils.strings.formatStringFromName(
          "subscribe-OPMLExportTitleList",
          [accountName]
        )
      : FeedUtils.strings.formatStringFromName(
          "subscribe-OPMLExportTitleStruct",
          [accountName]
        );
    let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);

    fp.defaultString = fileName;
    fp.defaultExtension = "opml";
    if (
      this.opmlLastSaveAsDir &&
      this.opmlLastSaveAsDir instanceof Ci.nsIFile
    ) {
      fp.displayDirectory = this.opmlLastSaveAsDir;
    }

    let opmlFilterText = FeedUtils.strings.GetStringFromName(
      "subscribe-OPMLExportOPMLFilesFilterText"
    );
    fp.appendFilter(opmlFilterText, "*.opml");
    fp.appendFilters(Ci.nsIFilePicker.filterAll);
    fp.filterIndex = 0;
    fp.init(window, title, Ci.nsIFilePicker.modeSave);

    return new Promise(resolve => {
      fp.open(rv => {
        if (
          (rv != Ci.nsIFilePicker.returnOK &&
            rv != Ci.nsIFilePicker.returnReplace) ||
          !fp.file
        ) {
          resolve(null);
          return;
        }

        this.opmlLastSaveAsDir = fp.file.parent;
        resolve(fp.file);
      });
    });
  },

  /**
   * Import feeds opml file Open filepicker function.
   *
   * @returns {Promise} [{nsIFile} file, {String} fileUrl] or null.
   */
  opmlPickOpenFile() {
    let title = FeedUtils.strings.GetStringFromName(
      "subscribe-OPMLImportTitle"
    );
    let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);

    fp.defaultString = "";
    if (this.opmlLastOpenDir && this.opmlLastOpenDir instanceof Ci.nsIFile) {
      fp.displayDirectory = this.opmlLastOpenDir;
    }

    let opmlFilterText = FeedUtils.strings.GetStringFromName(
      "subscribe-OPMLExportOPMLFilesFilterText"
    );
    fp.appendFilter(opmlFilterText, "*.opml");
    fp.appendFilters(Ci.nsIFilePicker.filterXML);
    fp.appendFilters(Ci.nsIFilePicker.filterAll);
    fp.init(window, title, Ci.nsIFilePicker.modeOpen);

    return new Promise(resolve => {
      fp.open(rv => {
        if (rv != Ci.nsIFilePicker.returnOK || !fp.file) {
          resolve(null);
          return;
        }

        this.opmlLastOpenDir = fp.file.parent;
        resolve([fp.file, fp.fileURL.spec]);
      });
    });
  },

  async exportOPML(aEvent) {
    // Account folder must be selected.
    let item = this.mView.currentItem;
    if (!item || !item.folder || !item.folder.isServer) {
      return;
    }

    this.mRSSServer = item.folder.server;
    let rootFolder = this.mRSSServer.rootFolder;
    let exportAsList = aEvent.ctrlKey;
    let SPACES2 = "  ";
    let SPACES4 = "    ";

    if (this.mRSSServer.rootFolder.hasSubFolders) {
      let opmlDoc = document.implementation.createDocument("", "opml", null);
      let opmlRoot = opmlDoc.documentElement;
      opmlRoot.setAttribute("version", "1.0");
      opmlRoot.setAttribute("xmlns:fz", "urn:forumzilla:");

      this.generatePPSpace(opmlRoot, SPACES2);

      // Make the <head> element.
      let head = opmlDoc.createElement("head");
      this.generatePPSpace(head, SPACES4);
      let titleText = FeedUtils.strings.formatStringFromName(
        "subscribe-OPMLExportFileDialogTitle",
        [this.brandShortName, rootFolder.prettyName]
      );
      let title = opmlDoc.createElement("title");
      title.appendChild(opmlDoc.createTextNode(titleText));
      head.appendChild(title);
      this.generatePPSpace(head, SPACES4);
      let dt = opmlDoc.createElement("dateCreated");
      dt.appendChild(opmlDoc.createTextNode(new Date().toUTCString()));
      head.appendChild(dt);
      this.generatePPSpace(head, SPACES2);
      opmlRoot.appendChild(head);

      this.generatePPSpace(opmlRoot, SPACES2);

      // Add <outline>s to the <body>.
      let body = opmlDoc.createElement("body");
      if (exportAsList) {
        this.generateOutlineList(rootFolder, body, SPACES4.length + 2);
      } else {
        this.generateOutlineStruct(rootFolder, body, SPACES4.length);
      }

      this.generatePPSpace(body, SPACES2);

      if (!body.childElementCount) {
        // No folders/feeds.
        return;
      }

      opmlRoot.appendChild(body);
      this.generatePPSpace(opmlRoot, "");

      // Get file to save from filepicker.
      let saveAsFile = await this.opmlPickSaveAsFile(exportAsList);
      if (!saveAsFile) {
        return;
      }

      let fos = FileUtils.openSafeFileOutputStream(saveAsFile);
      let serializer = new XMLSerializer();
      serializer.serializeToStream(opmlDoc, fos, "utf-8");
      FileUtils.closeSafeFileOutputStream(fos);

      let statusReport = FeedUtils.strings.formatStringFromName(
        "subscribe-OPMLExportDone",
        [saveAsFile.path]
      );
      this.updateStatusItem("statusText", statusReport);
      FeedUtils.log.info("exportOPML: " + statusReport);
    }
  },

  generatePPSpace(aNode, indentString) {
    aNode.appendChild(aNode.ownerDocument.createTextNode("\n"));
    aNode.appendChild(aNode.ownerDocument.createTextNode(indentString));
  },

  generateOutlineList(baseFolder, parent, indentLevel) {
    // Pretty printing.
    let indentString = " ".repeat(indentLevel - 2);

    let feedOutline;
    for (let folder of baseFolder.subFolders) {
      FeedUtils.log.debug(
        "generateOutlineList: folder - " + folder.filePath.path
      );
      if (
        !(folder instanceof Ci.nsIMsgFolder) ||
        folder.getFlag(Ci.nsMsgFolderFlags.Trash) ||
        folder.getFlag(Ci.nsMsgFolderFlags.Virtual)
      ) {
        continue;
      }

      FeedUtils.log.debug(
        "generateOutlineList: CONTINUE folderName - " + folder.name
      );

      if (folder.hasSubFolders) {
        FeedUtils.log.debug(
          "generateOutlineList: has subfolders - " + folder.name
        );
        // Recurse.
        this.generateOutlineList(folder, parent, indentLevel);
      }

      // Add outline elements with xmlUrls.
      let feeds = this.getFeedsInFolder(folder);
      for (let feed of feeds) {
        FeedUtils.log.debug(
          "generateOutlineList: folder has FEED url - " +
            folder.name +
            " : " +
            feed.url
        );
        feedOutline = this.exportOPMLOutline(feed, parent.ownerDocument);
        this.generatePPSpace(parent, indentString);
        parent.appendChild(feedOutline);
      }
    }
  },

  generateOutlineStruct(baseFolder, parent, indentLevel) {
    // Pretty printing.
    function indentString(len) {
      return " ".repeat(len - 2);
    }

    let folderOutline, feedOutline;
    for (let folder of baseFolder.subFolders) {
      FeedUtils.log.debug(
        "generateOutlineStruct: folder - " + folder.filePath.path
      );
      if (
        !(folder instanceof Ci.nsIMsgFolder) ||
        folder.getFlag(Ci.nsMsgFolderFlags.Trash) ||
        folder.getFlag(Ci.nsMsgFolderFlags.Virtual)
      ) {
        continue;
      }

      FeedUtils.log.debug(
        "generateOutlineStruct: CONTINUE folderName - " + folder.name
      );

      // Make a folder outline element.
      folderOutline = parent.ownerDocument.createElement("outline");
      folderOutline.setAttribute("title", folder.prettyName);
      this.generatePPSpace(parent, indentString(indentLevel + 2));

      if (folder.hasSubFolders) {
        FeedUtils.log.debug(
          "generateOutlineStruct: has subfolders - " + folder.name
        );
        // Recurse.
        this.generateOutlineStruct(folder, folderOutline, indentLevel + 2);
      }

      let feeds = this.getFeedsInFolder(folder);
      for (let feed of feeds) {
        // Add feed outline elements with xmlUrls.
        FeedUtils.log.debug(
          "generateOutlineStruct: folder has FEED url - " +
            folder.name +
            " : " +
            feed.url
        );
        feedOutline = this.exportOPMLOutline(feed, parent.ownerDocument);
        this.generatePPSpace(folderOutline, indentString(indentLevel + 4));
        folderOutline.appendChild(feedOutline);
      }

      parent.appendChild(folderOutline);
    }
  },

  exportOPMLOutline(aFeed, aDoc) {
    let outRv = aDoc.createElement("outline");
    outRv.setAttribute("type", "rss");
    outRv.setAttribute("title", aFeed.title);
    outRv.setAttribute("text", aFeed.title);
    outRv.setAttribute("version", "RSS");
    outRv.setAttribute("fz:quickMode", aFeed.quickMode);
    outRv.setAttribute("fz:options", JSON.stringify(aFeed.options));
    outRv.setAttribute("xmlUrl", aFeed.url);
    outRv.setAttribute("htmlUrl", aFeed.link);
    return outRv;
  },

  async importOPML() {
    // Account folder must be selected in subscribe dialog.
    let item = this.mView ? this.mView.currentItem : null;
    if (!item || !item.folder || !item.folder.isServer) {
      return;
    }

    let server = item.folder.server;
    // Get file and file url to open from filepicker.
    let [openFile, openFileUrl] = await this.opmlPickOpenFile();

    this.mActionMode = this.kImportingOPML;
    this.updateButtons(null);
    this.selectFolder(item.folder, { select: false, open: true });
    let statusReport = FeedUtils.strings.GetStringFromName("subscribe-loading");
    this.updateStatusItem("statusText", statusReport);
    // If there were a getElementsByAttribute in html, we could go determined...
    this.updateStatusItem("progressMeter", "?");

    if (
      !(await this.importOPMLFile(
        openFile,
        openFileUrl,
        server,
        this.importOPMLFinished
      ))
    ) {
      this.mActionMode = null;
      this.updateButtons(item);
      this.clearStatusInfo();
    }
  },

  /**
   * Import opml file into a feed account.  Used by the Subscribe dialog and
   * the Import wizard.
   *
   * @param {nsIFile} aFile                - The opml file.
   * @param {String} aFileUrl              - The opml file url.
   * @param {nsIMsgIncomingServer} aServer - The account server.
   * @param {Function} aCallback           - Callback function.
   *
   * @returns {Boolean}                    - false if error.
   */
  async importOPMLFile(aFile, aFileUrl, aServer, aCallback) {
    if (aServer && aServer instanceof Ci.nsIMsgIncomingServer) {
      this.mRSSServer = aServer;
    }

    if (!aFile || !aFileUrl || !this.mRSSServer) {
      return false;
    }

    let opmlDom, statusReport;
    FeedUtils.log.debug(
      "importOPMLFile: fileName:fileUrl - " + aFile.leafName + ":" + aFileUrl
    );
    let request = new Request(aFileUrl);
    await fetch(request)
      .then(function(response) {
        if (!response.ok) {
          // If the OPML file is not readable/accessible.
          statusReport = FeedUtils.strings.GetStringFromName(
            "subscribe-errorOpeningFile"
          );
          return null;
        }

        return response.text();
      })
      .then(function(responseText) {
        if (responseText != null) {
          opmlDom = new DOMParser().parseFromString(
            responseText,
            "application/xml"
          );
          if (
            !(opmlDom instanceof XMLDocument) ||
            opmlDom.documentElement.namespaceURI ==
              FeedUtils.MOZ_PARSERERROR_NS ||
            opmlDom.documentElement.tagName != "opml" ||
            !(
              opmlDom.querySelector("body") &&
              opmlDom.querySelector("body").childElementCount
            )
          ) {
            // If the OPML file is invalid or empty.
            statusReport = FeedUtils.strings.formatStringFromName(
              "subscribe-OPMLImportInvalidFile",
              [aFile.leafName]
            );
          }
        }
      })
      .catch(function(error) {
        statusReport = FeedUtils.strings.GetStringFromName(
          "subscribe-errorOpeningFile"
        );
        FeedUtils.log.error("importOPMLFile: error - " + error.message);
      });

    if (statusReport) {
      FeedUtils.log.error("importOPMLFile: status - " + statusReport);
      Services.prompt.alert(window, null, statusReport);
      return false;
    }

    let body = opmlDom.querySelector("body");
    this.importOPMLOutlines(body, this.mRSSServer, aCallback);
    return true;
  },

  importOPMLOutlines(aBody, aRSSServer, aCallback) {
    let win = this;
    let rssServer = aRSSServer;
    let callback = aCallback;
    let outline, feedFolder;
    let badTag = false;
    let firstFeedInFolderQuickMode = null;
    let lastFolder;
    let feedsAdded = 0;
    let rssOutlines = 0;

    function processor(aParentNode, aParentFolder) {
      FeedUtils.log.trace(
        "importOPMLOutlines: PROCESSOR tag:name:children - " +
          aParentNode.tagName +
          ":" +
          aParentNode.getAttribute("text") +
          ":" +
          aParentNode.childElementCount
      );
      while (true) {
        if (aParentNode.tagName == "body" && !aParentNode.childElementCount) {
          // Finished.
          let statusReport = win.importOPMLStatus(feedsAdded, rssOutlines);
          callback(statusReport, lastFolder, win);
          return;
        }

        outline = aParentNode.firstElementChild;
        if (outline.tagName != "outline") {
          FeedUtils.log.info(
            "importOPMLOutlines: skipping, node is not an " +
              "<outline> - <" +
              outline.tagName +
              ">"
          );
          badTag = true;
          break;
        }

        let outlineName =
          outline.getAttribute("text") ||
          outline.getAttribute("title") ||
          outline.getAttribute("xmlUrl");
        let feedUrl, folder;

        if (outline.getAttribute("type") == "rss") {
          // A feed outline.
          feedUrl =
            outline.getAttribute("xmlUrl") || outline.getAttribute("url");
          if (!feedUrl) {
            FeedUtils.log.info(
              "importOPMLOutlines: skipping, type=rss <outline> " +
                "has no url - " +
                outlineName
            );
            break;
          }

          rssOutlines++;
          feedFolder = aParentFolder;

          if (FeedUtils.feedAlreadyExists(feedUrl, rssServer)) {
            FeedUtils.log.info(
              "importOPMLOutlines: feed already subscribed in account " +
                rssServer.prettyName +
                ", url - " +
                feedUrl
            );
            break;
          }

          if (
            aParentNode.tagName == "outline" &&
            aParentNode.getAttribute("type") != "rss"
          ) {
            // Parent is a folder, already created.
            folder = feedFolder;
          } else {
            // Parent is not a folder outline, likely the <body> in a flat list.
            // Create feed's folder with feed's name and account rootFolder as
            // parent of feed's folder.
            // NOTE: Assume a type=rss outline must be a leaf and is not a
            // direct parent of another type=rss outline; such a structure
            // may lead to unintended nesting and inaccurate counts.
            folder = rssServer.rootFolder;
          }

          // Create the feed.
          let quickMode = outline.hasAttribute("fz:quickMode")
            ? outline.getAttribute("fz:quickMode") == "true"
            : rssServer.getBoolValue("quickMode");
          let options = outline.getAttribute("fz:options");
          options = options ? JSON.parse(options) : null;

          if (firstFeedInFolderQuickMode === null) {
            // The summary/web page pref applies to all feeds in a folder,
            // though it is a property of an individual feed.  This can be
            // set (and is obvious) in the subscribe dialog; ensure import
            // doesn't leave mismatches if mismatched in the opml file.
            firstFeedInFolderQuickMode = quickMode;
          } else {
            quickMode = firstFeedInFolderQuickMode;
          }

          let feedProperties = {
            feedName: outlineName,
            feedLocation: feedUrl,
            feedFolder: folder,
            quickMode,
            options,
          };

          FeedUtils.log.info(
            "importOPMLOutlines: importing feed: name, url - " +
              outlineName +
              ", " +
              feedUrl
          );

          let feed = win.storeFeed(feedProperties);
          if (outline.hasAttribute("htmlUrl")) {
            feed.link = outline.getAttribute("htmlUrl");
          }

          feed.createFolder();
          if (!feed.folder) {
            // Non success. Remove intermediate traces from the feeds database.
            if (feed && feed.url && feed.server) {
              FeedUtils.deleteFeed(feed);
            }

            FeedUtils.log.info(
              "importOPMLOutlines: skipping, error creating folder - '" +
                feed.folderName +
                "' from outlineName - '" +
                outlineName +
                "' in parent folder " +
                aParentFolder.filePath.path
            );
            badTag = true;
            break;
          }

          // Add the feed to the databases.
          FeedUtils.addFeed(feed);
          // Feed correctly added.
          feedsAdded++;
          lastFolder = feed.folder;
        } else {
          // A folder outline. If a folder exists in the account structure at
          // the same level as in the opml structure, feeds are placed into the
          // existing folder.
          let folderName = outlineName;
          try {
            feedFolder = aParentFolder.getChildNamed(folderName);
          } catch (ex) {
            // Folder not found, create it.
            FeedUtils.log.info(
              "importOPMLOutlines: creating folder - '" +
                folderName +
                "' from outlineName - '" +
                outlineName +
                "' in parent folder " +
                aParentFolder.filePath.path
            );
            firstFeedInFolderQuickMode = null;
            try {
              feedFolder = aParentFolder
                .QueryInterface(Ci.nsIMsgLocalMailFolder)
                .createLocalSubfolder(folderName);
            } catch (ex) {
              // An error creating. Skip it.
              FeedUtils.log.info(
                "importOPMLOutlines: skipping, error creating folder - '" +
                  folderName +
                  "' from outlineName - '" +
                  outlineName +
                  "' in parent folder " +
                  aParentFolder.filePath.path
              );
              let xfolder = aParentFolder.getChildNamed(folderName);
              aParentFolder.propagateDelete(xfolder, true, null);
              badTag = true;
              break;
            }
          }
        }

        break;
      }

      if (!outline.childElementCount || badTag) {
        // Remove leaf nodes that are processed or bad tags from the opml dom,
        // and go back to reparse.  This method lets us use setTimeout to
        // prevent UI hang, in situations of both deep and shallow trees.
        // A yield/generator.next() method is fine for shallow trees, but not
        // the true recursion required for deeper trees; both the shallow loop
        // and the recurse should give it up.
        outline.remove();
        badTag = false;
        outline = aBody;
        feedFolder = rssServer.rootFolder;
      }

      setTimeout(() => {
        processor(outline, feedFolder);
      }, 0);
    }

    processor(aBody, rssServer.rootFolder);
  },

  importOPMLStatus(aFeedsAdded, aRssOutlines, aFolderOutlines) {
    let statusReport;
    if (aRssOutlines > aFeedsAdded) {
      statusReport = FeedUtils.strings.formatStringFromName(
        "subscribe-OPMLImportStatus",
        [
          PluralForm.get(
            aFeedsAdded,
            FeedUtils.strings.GetStringFromName(
              "subscribe-OPMLImportUniqueFeeds"
            )
          ).replace("#1", aFeedsAdded),
          PluralForm.get(
            aRssOutlines,
            FeedUtils.strings.GetStringFromName(
              "subscribe-OPMLImportFoundFeeds"
            )
          ).replace("#1", aRssOutlines),
        ],
        2
      );
    } else {
      statusReport = PluralForm.get(
        aFeedsAdded,
        FeedUtils.strings.GetStringFromName("subscribe-OPMLImportFeedCount")
      ).replace("#1", aFeedsAdded);
    }

    return statusReport;
  },

  importOPMLFinished(aStatusReport, aLastFolder, aWin) {
    if (aLastFolder) {
      aWin.selectFolder(aLastFolder, { select: false, newFolder: aLastFolder });
      aWin.selectFolder(aLastFolder.parent);
    }
    aWin.mActionMode = null;
    aWin.updateButtons(aWin.mView.currentItem);
    aWin.clearStatusInfo();
    aWin.updateStatusItem("statusText", aStatusReport);
  },
};
