/* ***** BEGIN LICENSE BLOCK ***** 
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the Tree Style Tab.
 *
 * The Initial Developer of the Original Code is YUKI "Piro" Hiroshi.
 * Portions created by the Initial Developer are Copyright (C) 2010-2017
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s): YUKI "Piro" Hiroshi <piro.outsider.reflex@gmail.com>
 *                 Infocatcher <https://github.com/Infocatcher>
 *                 Tetsuharu OHZEKI <https://github.com/saneyuki>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ******/
'use strict';


import RichConfirm from '/extlib/RichConfirm.js';

import {
  log as internalLogger,
  wait,
  configs
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as Tabs from '/common/tabs.js';
import * as TabsOpen from '/common/tabs-open.js';
import * as Tree from '/common/tree.js';
import * as Commands from '/common/commands.js';
import * as TSTAPI from '/common/tst-api.js';
import * as Scroll from './scroll.js';
import * as EventUtils from './event-utils.js';
import * as SidebarTabs from './sidebar-tabs.js';

import Tab from '/common/Tab.js';

function log(...args) {
  internalLogger('sidebar/drag-and-drop', ...args);
}


const kTREE_DROP_TYPE   = 'application/x-treestyletab-tree';
const kTYPE_X_MOZ_URL   = 'text/x-moz-url';
const kTYPE_URI_LIST    = 'text/uri-list';
const kBOOKMARK_FOLDER  = 'x-moz-place:';

const kDROP_BEFORE  = 'before';
const kDROP_ON_SELF = 'self';
const kDROP_AFTER   = 'after';
const kDROP_IMPOSSIBLE = 'impossible';

const kDROP_POSITION = 'data-drop-position';

const kTABBAR_STATE_TAB_DRAGGING  = 'tab-dragging';
const kTABBAR_STATE_LINK_DRAGGING = 'link-dragging';

let mLongHoverExpandedTabs = [];
let mLongHoverTimer;
let mLongHoverTimerNext;

let mDraggingOnSelfWindow = false;
let mDraggingOnDraggedTabs = false;

let mCapturingForDragging = false;
let mReadyToCaptureMouseEvents = false;
let mLastDragEnteredTarget = null;
let mLastDropPosition      = null;
let mDragTargetIsClosebox  = false;
let mCurrentDragData       = null;

let mDragBehaviorNotification;

export function init() {
  document.addEventListener('dragstart', onDragStart); // eslint-disable-line no-use-before-define
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('dragend', onDragEnd);
  document.addEventListener('drop', onDrop);

  browser.runtime.onMessage.addListener(onMessage);

  mDragBehaviorNotification = document.getElementById('tab-drag-notification');
}


export function isCapturingForDragging() {
  return mCapturingForDragging;
}

// for backward compatibility with Multiple Tab Handler 2.x on Firefox ESR60
export async function legacyStartMultiDrag(tab, isClosebox) {
  const windowId = Tabs.getWindow();
  const results = await TSTAPI.sendMessage({
    type:   TSTAPI.kNOTIFY_TAB_DRAGREADY,
    tab:    TSTAPI.serializeTab(tab),
    window: windowId,
    windowId,
    startOnClosebox: isClosebox
  });
  if (results.every(result => result.result !== false)) {
    mReadyToCaptureMouseEvents = true;
  }
  return results;
}

export function endMultiDrag(tab, coordinates) {
  const serializedTab = tab && TSTAPI.serializeTab(tab);
  if (mCapturingForDragging) {
    window.removeEventListener('mouseover', onTSTAPIDragEnter, { capture: true });
    window.removeEventListener('mouseout',  onTSTAPIDragExit, { capture: true });
    document.releaseCapture();

    TSTAPI.sendMessage({
      type:    TSTAPI.kNOTIFY_TAB_DRAGEND,
      tab:     serializedTab,
      window:  tab && tab.windowId,
      windowId: tab && tab.windowId,
      clientX: coordinates.clientX,
      clientY: coordinates.clientY
    });

    mLastDragEnteredTarget = null;
  }
  else if (mReadyToCaptureMouseEvents) {
    TSTAPI.sendMessage({
      type:    TSTAPI.kNOTIFY_TAB_DRAGCANCEL,
      tab:     serializedTab,
      window:  tab && tab.windowId,
      windowId: tab && tab.windowId,
      clientX: coordinates.clientX,
      clientY: coordinates.clientY
    });
  }
  mCapturingForDragging = false;
  mReadyToCaptureMouseEvents = false;
}

function setDragData(dragData) {
  return mCurrentDragData = dragData;
}


/* helpers */

function getDragDataFromOneTab(tab, options = {}) {
  if (!tab)
    return {
      tab:      null,
      tabs:     [],
      windowId: null
    };

  const draggedTabs = options.shouldIgnoreDescendants ? [tab] : getDraggedTabsFromOneTab(tab);
  return {
    tab:      tab,
    tabs:     draggedTabs,
    windowId: tab.windowId
  };
}

function getDraggedTabsFromOneTab(tab) {
  if (Tabs.isSelected(tab))
    return Tabs.getSelectedTabs(tab.windowId);
  return [tab].concat(tab.$TST.descendants);
}

function sanitizeDragData(dragData) {
  return {
    tab:      Tabs.sanitize(dragData.tab),
    tabs:     dragData.tabs.map(Tabs.sanitize),
    windowId: dragData.windowId
  };
}

function getDropAction(event) {
  const dragOverTab = EventUtils.getTabFromEvent(event);
  const targetTab   = dragOverTab || EventUtils.getTabFromTabbarEvent(event);
  const info = {
    dragOverTab,
    targetTab,
    dropPosition:  null,
    action:        null,
    parent:        null,
    insertBefore:  null,
    insertAfter:   null,
    defineGetter(name, getter) {
      delete this[name];
      Object.defineProperty(this, name, {
        get() {
          delete this[name];
          return this[name] = getter.call(this);
        },
        configurable: true,
        enumerable:   true
      });
    }
  };
  info.defineGetter('dragData', () => {
    const dragData = event.dataTransfer.getData(kTREE_DROP_TYPE);
    return (dragData && JSON.parse(dragData)) || mCurrentDragData;
  });
  info.defineGetter('draggedTab', () => {
    const dragData = info.dragData;
    return dragData && dragData.tab;
  });
  info.defineGetter('draggedTabs', () => {
    const dragData = info.dragData;
    return (dragData && dragData.tabs).filter(tab => !!tab) || [];
  });
  info.defineGetter('draggedTabIds', () => {
    return info.draggedTabs.map(tab => tab.id);
  });
  info.defineGetter('targetTabs', () => {
    return Tabs.getAllTabs(Tabs.getWindow());
  });
  info.defineGetter('firstTargetTab', () => {
    return Tabs.getFirstNormalTab(Tabs.getWindow()) || info.targetTabs[0];
  });
  info.defineGetter('lastTargetTab', () => {
    return info.targetTabs[info.targetTabs.length - 1];
  });
  info.defineGetter('canDrop', () => {
    if (info.dropPosition == kDROP_IMPOSSIBLE)
      return false;

    const draggedTab = info.dragData && info.dragData.tab;
    const isPrivateBrowsingTabDragged = draggedTab && draggedTab.incognito;
    if (draggedTab &&
        isPrivateBrowsingTabDragged != info.dragOverTab || Tabs.getFirstTab(draggedTab.windowId).incognito) {
      return false;
    }
    else if (info.draggedTab) {
      if (info.action & Constants.kACTION_ATTACH) {
        if (info.parent &&
            info.parent.id == info.draggedTab.id) {
          return false;
        }
        else if (info.dragOverTab) {
          if (info.draggedTabIds.includes(info.dragOverTab.id))
            return false;
          const ancestors = Tab.getAncestors(info.dragOverTab);
          /* too many function call in this way, so I use alternative way for better performance.
          return !info.draggedTabIds.includes(info.dragOverTab.id) &&
                   Tabs.collectRootTabs(info.draggedTabs).every(rootTab =>
                     !ancestors.includes(rootTab)
                   );
          */
          for (const tab of info.draggedTabs.slice(0).reverse()) {
            const parent = tab.$TST.parent;
            if (!parent && ancestors.includes(parent))
              return false;
          }
          return true;
        }
      }
    }

    if (info.dragOverTab &&
        (info.dragOverTab.hidden ||
         (info.dragOverTab.$TST.collapsed &&
          info.dropPosition != kDROP_AFTER)))
      return false;

    return true;
  });
  info.defineGetter('EventUtils.isCopyAction', () => EventUtils.isCopyAction(event));
  info.defineGetter('dropEffect', () => getDropEffectFromDropAction(info));

  if (!targetTab) {
    //log('dragging on non-tab element');
    const action = Constants.kACTION_MOVE | Constants.kACTION_DETACH;
    if (event.clientY < info.firstTargetTab.$TST.element.getBoundingClientRect().top) {
      //log('dragging above the first tab');
      info.targetTab    = info.insertBefore = info.firstTargetTab;
      info.dropPosition = kDROP_BEFORE;
      info.action       = action;
      if (info.draggedTab &&
          !info.draggedTab.pinned &&
          info.targetTab.pinned)
        info.dropPosition = kDROP_IMPOSSIBLE;
    }
    else if (event.clientY > info.lastTargetTab.$TST.element.getBoundingClientRect().bottom) {
      //log('dragging below the last tab');
      info.targetTab    = info.insertAfter = info.lastTargetTab;
      info.dropPosition = kDROP_AFTER;
      info.action       = action;
      if (info.draggedTab &&
          info.draggedTab.pinned &&
          !info.targetTab.pinned)
        info.dropPosition = kDROP_IMPOSSIBLE;
    }
    return info;
  }

  /**
   * Basically, tabs should have three areas for dropping of items:
   * [start][center][end], but, pinned tabs couldn't have its tree.
   * So, if a tab is dragged and the target tab is pinned, then, we
   * have to ignore the [center] area.
   */
  const onPinnedTab         = targetTab.pinned;
  const dropAreasCount      = (info.draggedTab && onPinnedTab) ? 2 : 3 ;
  const targetTabRect       = targetTab.$TST.element.getBoundingClientRect();
  const targetTabCoordinate = onPinnedTab ? targetTabRect.left : targetTabRect.top ;
  const targetTabSize       = onPinnedTab ? targetTabRect.width : targetTabRect.height ;
  let beforeOrAfterDropAreaSize;
  if (dropAreasCount == 2) {
    beforeOrAfterDropAreaSize = Math.round(targetTabSize / dropAreasCount);
  }
  else { // enlarge the area to dop something on the tab itself
    beforeOrAfterDropAreaSize = Math.round(targetTabSize / 4);
  }
  const eventCoordinate = onPinnedTab ? event.clientX : event.clientY;
  //log('coordinates: ', {
  //  event: eventCoordinate,
  //  targetTab: targetTabCoordinate,
  //  area: beforeOrAfterDropAreaSize
  //});
  if (eventCoordinate < targetTabCoordinate + beforeOrAfterDropAreaSize) {
    info.dropPosition = kDROP_BEFORE;
    info.insertBefore = info.firstTargetTab;
  }
  else if (dropAreasCount == 2 ||
           eventCoordinate > targetTabCoordinate + targetTabSize - beforeOrAfterDropAreaSize) {
    info.dropPosition = kDROP_AFTER;
    info.insertAfter  = info.lastTargetTab;
  }
  else {
    info.dropPosition = kDROP_ON_SELF;
  }

  switch (info.dropPosition) {
    case kDROP_ON_SELF: {
      log('drop position = on ', info.targetTab.id);
      info.action       = Constants.kACTION_ATTACH;
      info.parent       = targetTab;
      info.insertBefore = configs.insertNewChildAt == Constants.kINSERT_FIRST ?
        (targetTab && targetTab.$TST.firstChild || targetTab.$TST.nearestVisibleFollowing) :
        (targetTab.$TST.nextSibling || targetTab.$TST.nearestFollowingForeigner);
      info.insertAfter  = configs.insertNewChildAt == Constants.kINSERT_FIRST ?
        targetTab :
        (targetTab.$TST.lastDescendant || targetTab);
      if (info.draggedTab &&
          info.draggedTab.pinned != targetTab.pinned)
        info.dropPosition = kDROP_IMPOSSIBLE;
      if (configs.debug)
        log(' calculated info: ', info);
    }; break;

    case kDROP_BEFORE: {
      log('drop position = before ', info.targetTab.id);
      const referenceTabs = Tree.calculateReferenceTabsFromInsertionPosition(info.draggedTab, {
        insertBefore: targetTab
      });
      if (referenceTabs.parent)
        info.parent = referenceTabs.parent;
      if (referenceTabs.insertBefore)
        info.insertBefore = referenceTabs.insertBefore;
      if (referenceTabs.insertAfter)
        info.insertAfter = referenceTabs.insertAfter;
      info.action = Constants.kACTION_MOVE | (info.parent ? Constants.kACTION_ATTACH : Constants.kACTION_DETACH );
      //if (info.insertBefore)
      //  log('insertBefore = ', dumpTab(info.insertBefore));
      if (info.draggedTab &&
          info.draggedTab.pinned != targetTab.pinned)
        info.dropPosition = kDROP_IMPOSSIBLE;
      if (configs.debug)
        log(' calculated info: ', info);
    }; break;

    case kDROP_AFTER: {
      log('drop position = after ', info.targetTab.id);
      const referenceTabs = Tree.calculateReferenceTabsFromInsertionPosition(info.draggedTab, {
        insertAfter: targetTab
      });
      if (referenceTabs.parent)
        info.parent = referenceTabs.parent;
      if (referenceTabs.insertBefore)
        info.insertBefore = referenceTabs.insertBefore;
      if (referenceTabs.insertAfter)
        info.insertAfter = referenceTabs.insertAfter;
      info.action = Constants.kACTION_MOVE | (info.parent ? Constants.kACTION_ATTACH : Constants.kACTION_DETACH );
      if (info.insertBefore) {
        /* strategy
             +-----------------------------------------------------
             |[TARGET   ]
             |     <= attach dragged tab to the parent of the target as its next sibling
             |  [DRAGGED]
             +-----------------------------------------------------
        */
        if (info.draggedTab &&
            info.draggedTab.id == info.insertBefore.id) {
          info.action      = Constants.kACTION_MOVE | Constants.kACTION_ATTACH;
          info.parent      = targetTab.$TST.parent;
          let insertBefore = targetTab.$TST.nextSibling;
          let ancestor     = info.parent;
          while (ancestor && !insertBefore) {
            insertBefore = ancestor.$TST.nextSibling;
            ancestor     = ancestor.$TST.parent;
          }
          info.insertBefore = insertBefore;
          info.insertAfter  = targetTab.$TST.lastDescendant;
        }
      }
      if (info.draggedTab &&
          info.draggedTab.pinned != targetTab.$TST.precedesPinned)
        info.dropPosition = kDROP_IMPOSSIBLE;
      if (configs.debug)
        log(' calculated info: ', info);
    }; break;
  }

  return info;
}
function getDropEffectFromDropAction(actionInfo) {
  if (!actionInfo.canDrop)
    return 'none';
  if (!actionInfo.draggedTab)
    return 'link';
  if (actionInfo.isCopyAction)
    return 'copy';
  return 'move';
}

export function clearDropPosition() {
  for (const target of document.querySelectorAll(`[${kDROP_POSITION}]`)) {
    target.removeAttribute(kDROP_POSITION)
  }
}

export function clearDraggingTabsState() {
  for (const tab of Tabs.getDraggingTabs(Tabs.getWindow())) {
    Tabs.removeState(tab, Constants.kTAB_STATE_DRAGGING);
  }
}

export function clearDraggingState() {
  const window = Tabs.trackedWindows.get(Tabs.getWindow());
  window.element.classList.remove(kTABBAR_STATE_TAB_DRAGGING);
  document.documentElement.classList.remove(kTABBAR_STATE_TAB_DRAGGING);
  document.documentElement.classList.remove(kTABBAR_STATE_LINK_DRAGGING);
}

function isDraggingAllTabs(tab, tabs) {
  const draggingTabs = Tabs.getDraggingTabs(tab.windowId);
  return draggingTabs.length == (tabs || Tabs.getAllTabs(tab.windowId)).length;
}
 
function isDraggingAllActiveTabs(tab) {
  return isDraggingAllTabs(tab, Tabs.getAllTabs(tab.windowId));
}

function collapseAutoExpandedTabsWhileDragging() {
  if (mLongHoverExpandedTabs.length > 0 &&
      configs.autoExpandOnLongHoverRestoreIniitalState) {
    for (const tab of mLongHoverExpandedTabs) {
      Tree.collapseExpandSubtree(tab, {
        collapsed: false,
        justNow:   true,
        inRemote:  true
      });
    }
  }
  mLongHoverExpandedTabs = [];
}

async function handleDroppedNonTabItems(event, dropActionInfo) {
  event.stopPropagation();

  const uris = retrieveURIsFromDragEvent(event);
  // uris.forEach(uRI => {
  //   if (uRI.indexOf(Constants.kURI_BOOKMARK_FOLDER) != 0)
  //     securityCheck(uRI, event);
  // });
  log('handleDroppedNonTabItems: ', uris);

  const dragOverTab = dropActionInfo.dragOverTab;
  if (dragOverTab &&
      dropActionInfo.dropPosition == kDROP_ON_SELF &&
      !dragOverTab.pinned) {
    const behavior = await getDroppedLinksOnTabBehavior();
    if (behavior <= Constants.kDROPLINK_ASK)
      return;
    if (behavior & Constants.kDROPLINK_LOAD) {
      browser.runtime.sendMessage({
        type:     Constants.kCOMMAND_SELECT_TAB,
        windowId: Tabs.getWindow(),
        tabId:    dropActionInfo.dragOverTab.id
      });
      await TabsOpen.loadURI(uris.shift(), {
        tab:      dropActionInfo.dragOverTab,
        inRemote: true
      });
    }
  }
  await TabsOpen.openURIsInTabs(uris, {
    windowId:     Tabs.getWindow(),
    parent:       dropActionInfo.parent,
    insertBefore: dropActionInfo.insertBefore,
    insertAfter:  dropActionInfo.insertAfter,
    inRemote:     true
  });
}

function retrieveURIsFromDragEvent(event) {
  log('retrieveURIsFromDragEvent');
  const dt    = event.dataTransfer;
  const types = [
    kTYPE_URI_LIST,
    kTYPE_X_MOZ_URL,
    'text/plain'
  ];
  let urls = [];
  for (const type of types) {
    const urlData  = dt.getData(type);
    if (urlData)
      urls = urls.concat(retrieveURIsFromData(urlData, type));
    if (urls.length)
      break;
  }
  log(' => retrieved: ', urls);
  urls = urls.filter(uRI =>
    uRI &&
      uRI.length &&
      uRI.indexOf(kBOOKMARK_FOLDER) == 0 ||
      !/^\s*(javascript|data):/.test(uRI)
  );
  log('  => filtered: ', urls);

  urls = urls.map(fixupURIFromText);
  log('  => fixed: ', urls);

  return urls;
}

function retrieveURIsFromData(data, type) {
  log('retrieveURIsFromData: ', type, data);
  switch (type) {
    case kTYPE_URI_LIST:
      return data
        .replace(/\r/g, '\n')
        .replace(/\n\n+/g, '\n')
        .split('\n')
        .filter(line => {
          return line.charAt(0) != '#';
        });

    case kTYPE_X_MOZ_URL:
      return data
        .trim()
        .replace(/\r/g, '\n')
        .replace(/\n\n+/g, '\n')
        .split('\n')
        .filter((_line, index) => {
          return index % 2 == 0;
        });

    case 'text/plain':
      return data
        .replace(/\r/g, '\n')
        .replace(/\n\n+/g, '\n')
        .trim()
        .split('\n')
        .map(line => {
          return /^\w+:\/\/.+/.test(line) ? line : `about:treestyletab-search?${line}`;
        });
  }
  return [];
}

function fixupURIFromText(maybeURI) {
  if (/^\w+:/.test(maybeURI))
    return maybeURI;

  if (/^([^\.\s]+\.)+[^\.\s]{2}/.test(maybeURI))
    return `http://${maybeURI}`;

  return maybeURI;
}

async function getDroppedLinksOnTabBehavior() {
  let behavior = configs.dropLinksOnTabBehavior;
  if (behavior != Constants.kDROPLINK_ASK)
    return behavior;

  const confirm = new RichConfirm({
    message: browser.i18n.getMessage('dropLinksOnTabBehavior_message'),
    buttons: [
      browser.i18n.getMessage('dropLinksOnTabBehavior_load'),
      browser.i18n.getMessage('dropLinksOnTabBehavior_newtab')
    ],
    checkMessage: browser.i18n.getMessage('dropLinksOnTabBehavior_save')
  });
  const result = await confirm.show();
  switch (result.buttonIndex) {
    case 0:
      behavior = Constants.kDROPLINK_LOAD;
      break;
    case 1:
      behavior = Constants.kDROPLINK_NEWTAB;
      break;
    default:
      return result.buttonIndex;
  }
  if (result.checked)
    configs.dropLinksOnTabBehavior = behavior;
  return behavior;
}


/* DOM event listeners */

let mFinishCanceledDragOperation;

export const onDragStart = EventUtils.wrapWithErrorHandler(function onDragStart(event, options = {}) {
  log('onDragStart: start ', event, options);
  clearDraggingTabsState(); // clear previous state anyway

  const behavior = 'behavior' in options ? options.behavior :
    event.shiftKey ? configs.tabDragBehaviorShift :
      configs.tabDragBehavior;
  const shouldIgnoreDescendants = !(behavior & Constants.kDRAG_BEHAVIOR_WHOLE_TREE);
  const allowBookmark           = !!(behavior & Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK);

  const dragData = getDragDataFromOneTab(options.tab || EventUtils.getTabFromEvent(event), {
    shouldIgnoreDescendants
  });
  if (!dragData.tab) {
    log('onDragStart: canceled / no dragged tab from drag data');
    return;
  }

  const tab       = dragData.tab;
  const mousedown = EventUtils.getLastMousedown(event.button);

  if (mousedown && mousedown.expired) {
    log('onDragStart: canceled / expired');
    event.stopPropagation();
    event.preventDefault();
    mLastDragEnteredTarget = tab.$TST.element;
    const startOnClosebox = mDragTargetIsClosebox = mousedown.detail.closebox;
    if (startOnClosebox)
      mLastDragEnteredTarget = SidebarTabs.getClosebox(tab);
    const windowId = Tabs.getWindow();
    TSTAPI.sendMessage({
      type:   TSTAPI.kNOTIFY_TAB_DRAGSTART,
      tab:    TSTAPI.serializeTab(tab),
      window: windowId,
      windowId,
      startOnClosebox
    });
    window.addEventListener('mouseover', onTSTAPIDragEnter, { capture: true });
    window.addEventListener('mouseout',  onTSTAPIDragExit, { capture: true });
    document.body.setCapture(false);
    mCapturingForDragging = true;
    return;
  }

  EventUtils.cancelHandleMousedown();

  // dragging on clickable element will be expected to cancel the operation
  if (EventUtils.isEventFiredOnClosebox(options.tab && options.tab.$TST.element || event) ||
      EventUtils.isEventFiredOnClickable(options.tab && options.tab.$TST.element || event)) {
    log('onDragStart: canceled / on undraggable element');
    event.stopPropagation();
    event.preventDefault();
    return;
  }

  mDraggingOnSelfWindow = true;
  mDraggingOnDraggedTabs = true;
  mLastDropPosition = null;

  const dt = event.dataTransfer;
  dt.effectAllowed = 'copyMove';

  const sanitizedDragData = sanitizeDragData(dragData);
  dt.setData(kTREE_DROP_TYPE, JSON.stringify(sanitizedDragData));

  // Because addon cannot read drag data across private browsing mode,
  // we need to share detailed information of dragged tabs in different way!
  mCurrentDragData = sanitizedDragData;
  browser.runtime.sendMessage({
    type:     Constants.kCOMMAND_BROADCAST_CURRENT_DRAG_DATA,
    windowId: Tabs.getWindow(),
    dragData: sanitizedDragData
  });

  const mozUrl  = [];
  const urlList = [];
  for (const draggedTab of dragData.tabs) {
    Tabs.addState(draggedTab, Constants.kTAB_STATE_DRAGGING);
    mozUrl.push(`${draggedTab.url}\n${draggedTab.title}`);
    urlList.push(`#${draggedTab.title}\n${draggedTab.url}`);
  }
  if (allowBookmark) {
    log('set kTYPE_X_MOZ_URL');
    dt.setData(kTYPE_X_MOZ_URL, mozUrl.join('\n'));
    log('set kTYPE_URI_LIST');
    dt.setData(kTYPE_URI_LIST, urlList.join('\n'));
  }

  if (options.tab) {
    const tabRect = options.tab.$TST.element.getBoundingClientRect();
    dt.setDragImage(options.tab.$TST.element, event.clientX - tabRect.left, event.clientY - tabRect.top);
  }

  Tabs.trackedWindows.get(Tabs.getWindow()).element.classList.add(kTABBAR_STATE_TAB_DRAGGING);
  document.documentElement.classList.add(kTABBAR_STATE_TAB_DRAGGING);

  // The drag operation can be canceled by something, then
  // "dragend" event is not dispatched and TST wrongly keeps
  // its "dragging" state. So we clear the dragging state with
  // a delay. (This timer will be cleared immediately by dragover
  // event, if the dragging operation is not canceled.)
  // See also: https://github.com/piroor/treestyletab/issues/1778#issuecomment-404569842
  mFinishCanceledDragOperation = setTimeout(finishDrag, 250);

  if (!('behavior' in options) &&
      configs.showTabDragBehaviorNotification) {
    const currentBehavior = event.shiftKey ? configs.tabDragBehaviorShift : configs.tabDragBehavior;
    const invertedBehavior = event.shiftKey ? configs.tabDragBehavior : configs.tabDragBehaviorShift;
    const count            = dragData.tabs.length;
    const currentResult    = getTabDragBehaviorNotificationMessageType(currentBehavior, count);
    const invertedResult   = getTabDragBehaviorNotificationMessageType(invertedBehavior, count);
    const invertSuffix     = event.shiftKey ? 'without_shift' : 'with_shift';
    mDragBehaviorNotification.firstChild.textContent = [
      browser.i18n.getMessage(`tabDragBehaviorNotification_message_base`, [
        browser.i18n.getMessage(`tabDragBehaviorNotification_message_${currentResult}`)]),
      browser.i18n.getMessage(`tabDragBehaviorNotification_message_inverted_base_${invertSuffix}`, [
        browser.i18n.getMessage(`tabDragBehaviorNotification_message_${invertedResult}`)]),
    ].join('\n');
    mDragBehaviorNotification.firstChild.style.animationDuration = browser.i18n.getMessage('tabDragBehaviorNotification_message_duration');
    mDragBehaviorNotification.classList.remove('hiding');
    mDragBehaviorNotification.classList.add('shown');
  }

  TSTAPI.sendMessage({
    type:     TSTAPI.kNOTIFY_NATIVE_TAB_DRAGSTART,
    tab:      TSTAPI.serializeTab(tab),
    windowId: Tabs.getWindow()
  });

  log('onDragStart: started');
});

function getTabDragBehaviorNotificationMessageType(behavior, count) {
  if (behavior & Constants.kDRAG_BEHAVIOR_WHOLE_TREE && count > 1) {
    if (behavior & Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK)
      return 'tree_bookmark';
    else
      return 'tree_tearoff';
  }
  else {
    if (behavior & Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK)
      return 'tab_bookmark';
    else
      return 'tab_tearoff';
  }
}

let mLastDragOverTimestamp = null;

function onDragOver(event) {
  if (mFinishCanceledDragOperation) {
    clearTimeout(mFinishCanceledDragOperation);
    mFinishCanceledDragOperation = null;
  }

  event.preventDefault(); // this is required to override default dragover actions!
  Scroll.autoScrollOnMouseEvent(event);

  // reduce too much handling of too frequent dragover events...
  const now = Date.now();
  if (now - (mLastDragOverTimestamp || 0) < configs.minimumIntervalToProcessDragoverEvent)
    return;
  mLastDragOverTimestamp = now;

  const info = getDropAction(event);
  const dt   = event.dataTransfer;

  if (isEventFiredOnTabDropBlocker(event) ||
      !info.canDrop) {
    log('onDragOver: not droppable');
    dt.dropEffect = 'none';
    if (mLastDropPosition)
      clearDropPosition();
    mLastDropPosition = null;
    return;
  }

  const dropPositionTargetTab = info.targetTab && info.targetTab.$TST.nearestVisiblePreceding || info.targetTab;
  if (!dropPositionTargetTab) {
    log('onDragOver: no drop target tab');
    dt.dropEffect = 'none';
    mLastDropPosition = null;
    return;
  }

  if (!info.draggedTab ||
      dropPositionTargetTab.id != info.draggedTab.id) {
    const dropPosition = `${dropPositionTargetTab.id}:${info.dropPosition}`;
    if (dropPosition == mLastDropPosition) {
      log('onDragOver: no move');
      return;
    }
    clearDropPosition();
    dropPositionTargetTab.$TST.element.setAttribute(kDROP_POSITION, info.dropPosition);
    mLastDropPosition = dropPosition;
    log('onDragOver: set drop position to ', dropPosition);
  }
  else {
    mLastDropPosition = null;
  }
}
onDragOver = EventUtils.wrapWithErrorHandler(onDragOver);

function isEventFiredOnTabDropBlocker(event) {
  let node = event.target;
  if (node.nodeType != Node.ELEMENT_NODE)
    node = node.parentNode;
  return node && !!node.closest('.tab-drop-blocker');
}

function onDragEnter(event) {
  mDraggingOnSelfWindow = true;

  const info = getDropAction(event);
  try {
    const enteredTab = EventUtils.getTabFromEvent(event);
    const leftTab    = SidebarTabs.getTabFromDOMNode(event.relatedTarget);
    if (leftTab != enteredTab) {
      mDraggingOnDraggedTabs = (
        info.dragData &&
        info.dragData.tabs.some(tab => tab.id == enteredTab.id)
      );
    }
    Tabs.trackedWindows.get(Tabs.getWindow()).element.classList.add(kTABBAR_STATE_TAB_DRAGGING);
    document.documentElement.classList.add(kTABBAR_STATE_TAB_DRAGGING);
  }
  catch(_e) {
  }

  const dt   = event.dataTransfer;
  dt.dropEffect = info.dropEffect;
  if (info.dropEffect == 'link')
    document.documentElement.classList.add(kTABBAR_STATE_LINK_DRAGGING);

  if (!configs.autoExpandOnLongHover ||
      !info.canDrop ||
      !info.dragOverTab)
    return;

  reserveToProcessLongHover.cancel();

  if (info.draggedTab &&
      info.dragOverTab.id == info.draggedTab.id)
    return;

  reserveToProcessLongHover({
    dragOverTabId: info.targetTab && info.targetTab.id,
    draggedTabId:  info.draggedTab && info.draggedTab.id,
    dropEffect:    info.dropEffect
  });
}
onDragEnter = EventUtils.wrapWithErrorHandler(onDragEnter);

function reserveToProcessLongHover(params = {}) {
  mLongHoverTimerNext = setTimeout(() => {
    mLongHoverTimerNext = null;
    mLongHoverTimer = setTimeout(async () => {
      log('reservedProcessLongHover: ', params);

      const dragOverTab = Tab.get(params.dragOverTabId);
      if (!dragOverTab ||
          dragOverTab.$TST.element.getAttribute(kDROP_POSITION) != 'self')
        return;

      // auto-switch for staying on tabs
      if (!dragOverTab.active &&
          params.dropEffect == 'link') {
        browser.runtime.sendMessage({
          type:     Constants.kCOMMAND_SELECT_TAB,
          windowId: Tabs.getWindow(),
          tabId:    dragOverTab.id
        });
      }

      if (!Tree.shouldTabAutoExpanded(dragOverTab))
        return;

      // auto-expand for staying on a parent
      if (configs.autoExpandIntelligently) {
        Tree.collapseExpandTreesIntelligentlyFor(dragOverTab, { inRemote: true });
      }
      else {
        if (!mLongHoverExpandedTabs.includes(params.dragOverTabId))
          mLongHoverExpandedTabs.push(params.dragOverTabId);
        Tree.collapseExpandSubtree(dragOverTab, {
          collapsed: false,
          inRemote:  true
        });
      }
    }, configs.autoExpandOnLongHoverDelay);
  }, 0);
}
reserveToProcessLongHover.cancel = function() {
  clearTimeout(mLongHoverTimer);
  clearTimeout(mLongHoverTimerNext);
};

function onDragLeave(event) {
  let leftFromTabBar = false;
  try {
    const info       = getDropAction(event);
    const leftTab    = EventUtils.getTabFromEvent(event);
    const enteredTab = SidebarTabs.getTabFromDOMNode(event.relatedTarget);
    if (leftTab != enteredTab) {
      if (info.dragData &&
          info.dragData.tabs.some(tab => tab.id == leftTab.id) &&
          (!enteredTab ||
           !info.dragData.tabs.every(tab => tab.id == enteredTab.id))) {
        onDragLeave.delayedLeftFromDraggedTabs = setTimeout(() => {
          delete onDragLeave.delayedLeftFromDraggedTabs;
          mDraggingOnDraggedTabs = false;
        }, 10);
      }
      else {
        leftFromTabBar = !enteredTab || enteredTab.windowId != Tabs.getWindow();
        if (onDragLeave.delayedLeftFromDraggedTabs) {
          clearTimeout(onDragLeave.delayedLeftFromDraggedTabs);
          delete onDragLeave.delayedLeftFromDraggedTabs;
        }
      }
    }
  }
  catch(_e) {
    leftFromTabBar = true;
  }

  if (leftFromTabBar) {
    onDragLeave.delayedLeftFromTabBar = setTimeout(() => {
      delete onDragLeave.delayedLeftFromTabBar;
      mDraggingOnSelfWindow = false;
      mDraggingOnDraggedTabs = false;
      clearDropPosition();
      clearDraggingState();
      mLastDropPosition = null;
    }, 10);
  }
  else if (onDragLeave.delayedLeftFromTabBar) {
    clearTimeout(onDragLeave.delayedLeftFromTabBar);
    delete onDragLeave.delayedLeftFromTabBar;
  }

  clearTimeout(mLongHoverTimer);
  mLongHoverTimer = null;
}
onDragLeave = EventUtils.wrapWithErrorHandler(onDragLeave);

function onDrop(event) {
  setTimeout(() => collapseAutoExpandedTabsWhileDragging(), 0);
  if (mLastDropPosition) {
    clearDropPosition();
    mLastDropPosition = null;
  }

  const dropActionInfo = getDropAction(event);
  const dt = event.dataTransfer;
  if (dt.dropEffect != 'link' &&
      dt.dropEffect != 'move' &&
      dropActionInfo.dragData &&
      !dropActionInfo.dragData.tab) {
    log('invalid drop');
    return;
  }

  if (dropActionInfo.dragData &&
      dropActionInfo.dragData.tab) {
    log('there are dragged tabs');
    Commands.performTabsDragDrop({
      windowId:            dropActionInfo.dragData.windowId,
      tabs:                dropActionInfo.dragData.tabs,
      action:              dropActionInfo.action,
      attachTo:            dropActionInfo.parent,
      insertBefore:        dropActionInfo.insertBefore,
      insertAfter:         dropActionInfo.insertAfter,
      destinationWindowId: Tabs.getWindow(),
      duplicate:           dt.dropEffect == 'copy',
      inRemote:            true
    });
    return;
  }

  log('link or bookmark item is dropped');
  handleDroppedNonTabItems(event, dropActionInfo);
}
onDrop = EventUtils.wrapWithErrorHandler(onDrop);

function onDragEnd(event) {
  log('onDragEnd, ', { mDraggingOnSelfWindow, mDraggingOnDraggedTabs });

  let dragData = event.dataTransfer.getData(kTREE_DROP_TYPE);
  dragData = (dragData && JSON.parse(dragData)) || mCurrentDragData;
  if (dragData) {
    dragData.tab  = dragData.tab && Tab.get(dragData.tab.id) || dragData.tab;
    dragData.tabs = dragData.tabs.map(tab => Tab.get(tab.id) || tab);
  }

  // Don't clear flags immediately, because they are referred by following operations in this function.
  setTimeout(finishDrag, 0);

  if (event.dataTransfer.getData(kTYPE_URI_LIST)) {
    log('do nothing by TST for dropping just for bookmarking or linking');
    return;
  }

  if (event.dataTransfer.mozUserCancelled ||
      event.dataTransfer.dropEffect != 'none' ||
      //event.shiftKey || // don't ignore shift-drop, because it can be used to drag a parent tab as an individual tab.
      !configs.moveDroppedTabToNewWindowForUnhandledDragEvent) {
    log('dragged items are processed by someone: ', event.dataTransfer.dropEffect);
    return;
  }

  const dropTargetTab = EventUtils.getTabFromEvent(event);
  if (mDraggingOnDraggedTabs ||
      (dropTargetTab &&
       dragData &&
       dragData.tabs &&
       dragData.tabs.some(tab => tab.id == dropTargetTab.id))) {
    log('ignore drop on dragged tabs themselves');
    return;
  }

  const windowX = window.mozInnerScreenX * window.devicePixelRatio;
  const windowY = window.mozInnerScreenY * window.devicePixelRatio;
  const offset  = dragData.tab.$TST.element.getBoundingClientRect().height * window.devicePixelRatio / 2;
  log('dragend at: ', {
    windowX,
    windowY,
    windowW: window.innerWidth,
    windowH: window.innerHeight,
    eventScreenX: event.screenX,
    eventScreenY: event.screenY,
    eventClientX: event.clientX,
    eventClientY: event.clientY,
    offset
  });
  if (event.screenX >= windowX - offset &&
      event.screenY >= windowY - offset &&
      event.screenX <= windowX + window.innerWidth + offset &&
      event.screenY <= windowY + window.innerHeight + offset) {
    log('dropped near the tab bar (from coordinates): detaching is canceled');
    return;
  }

  log('trying to detach tab from window');
  event.stopPropagation();
  event.preventDefault();

  if (isDraggingAllActiveTabs(dragData.tab)) {
    log('all tabs are dragged, so it is nonsence to tear off them from the window');
    return;
  }

  Tree.openNewWindowFromTabs(dragData.tabs, {
    duplicate: EventUtils.isAccelKeyPressed(event),
    left:      event.screenX,
    top:       event.screenY,
    inRemote:  true
  });
}
onDragEnd = EventUtils.wrapWithErrorHandler(onDragEnd);

function finishDrag() {
  log('finishDrag');
  clearDraggingTabsState();

  mDragBehaviorNotification.classList.add('hiding');
  mDragBehaviorNotification.classList.remove('shown');
  setTimeout(() => {
    mDragBehaviorNotification.classList.remove('hiding');
  }, configs.collapseDuration);

  mDraggingOnSelfWindow = false;

  wait(100).then(() => {
    mCurrentDragData = null;
    browser.runtime.sendMessage({
      type:     Constants.kCOMMAND_BROADCAST_CURRENT_DRAG_DATA,
      windowId: Tabs.getWindow(),
      dragData: null
    });
  });

  clearDropPosition();
  mLastDropPosition = null;
  mLastDragOverTimestamp = null;
  clearDraggingState();
  collapseAutoExpandedTabsWhileDragging();
  mDraggingOnSelfWindow = false;
  mDraggingOnDraggedTabs = false;
}


/* drag on tabs API */

function onTSTAPIDragEnter(event) {
  Scroll.autoScrollOnMouseEvent(event);
  const tab = EventUtils.getTabFromEvent(event);
  let target = tab.$TST.element;
  if (mDragTargetIsClosebox && EventUtils.isEventFiredOnClosebox(event))
    target = SidebarTabs.getClosebox(tab);
  cancelDelayedTSTAPIDragExitOn(target);
  if (tab &&
      (!mDragTargetIsClosebox ||
       EventUtils.isEventFiredOnClosebox(event))) {
    if (target != mLastDragEnteredTarget) {
      TSTAPI.sendMessage({
        type:     TSTAPI.kNOTIFY_TAB_DRAGENTER,
        tab:      TSTAPI.serializeTab(tab),
        window:   tab.windowId,
        windowId: tab.windowId
      });
    }
  }
  mLastDragEnteredTarget = target;
}

function onTSTAPIDragExit(event) {
  if (mDragTargetIsClosebox &&
      !EventUtils.isEventFiredOnClosebox(event))
    return;
  const tab = EventUtils.getTabFromEvent(event);
  if (!tab)
    return;
  let target = tab.$TST.element;
  if (mDragTargetIsClosebox && EventUtils.isEventFiredOnClosebox(event))
    target = SidebarTabs.getClosebox(tab);
  cancelDelayedTSTAPIDragExitOn(target);
  target.onTSTAPIDragExitTimeout = setTimeout(() => {
    delete target.onTSTAPIDragExitTimeout;
    TSTAPI.sendMessage({
      type:     TSTAPI.kNOTIFY_TAB_DRAGEXIT,
      tab:      TSTAPI.serializeTab(tab),
      window:   tab.windowId,
      windowId: tab.windowId
    });
  }, 10);
}

function cancelDelayedTSTAPIDragExitOn(target) {
  if (target && target.onTSTAPIDragExitTimeout) {
    clearTimeout(target.onTSTAPIDragExitTimeout);
    delete target.onTSTAPIDragExitTimeout;
  }
}


function onMessage(message, _sender, _respond) {
  if (!message ||
      typeof message.type != 'string')
    return;

  switch (message.type) {
    case Constants.kCOMMAND_BROADCAST_CURRENT_DRAG_DATA:
      setDragData(message.dragData || null);
      break;
  }
}

