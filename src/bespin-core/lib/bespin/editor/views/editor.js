/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1
 *
 * The contents of this file are subject to the Mozilla Public License
 * Version 1.1 (the "License"); you may not use this file except in
 * compliance with the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS"
 * basis, WITHOUT WARRANTY OF ANY KIND, either express or implied.
 * See the License for the specific language governing rights and
 * limitations under the License.
 *
 * The Original Code is Bespin.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Bespin Team (bespin@mozilla.com)
 *
 * ***** END LICENSE BLOCK ***** */

var SC = require('sproutcore');

var bespin = require('bespin');
var syntax = require('bespin/syntax');
var actions = require('bespin/actions');
var keys = require('bespin/util/keys');
var cursor = require('bespin/cursor');
var scroller = require('bespin/editor/views/scroller');
var clipboard = require("bespin/clipboard");

var SelectionHelper = SC.Object.extend({
    editor: null,

    // returns an object with the startCol and endCol of the selection.
    // If the col is -1 on the endPos, the selection goes for the entire line
    // returns undefined if the row has no selection
    getRowSelectionPositions: function(rowIndex) {
        var startCol;
        var endCol;

        var selection = this.editor.getSelection();
        if (!selection) {
            return undefined;
        }
        if ((selection.endPos.row < rowIndex) || (selection.startPos.row > rowIndex)) {
            return undefined;
        }

        startCol = (selection.startPos.row < rowIndex) ? 0 : selection.startPos.col;
        endCol = (selection.endPos.row > rowIndex) ? -1 : selection.endPos.col;

        return { startCol: startCol, endCol: endCol };
    }
});

// The main editor view.
exports.EditorView = SC.View.extend({
    classNames: 'sc-canvas-view',
    displayProperties: ['value', 'shouldAutoResize'],
    tagName: 'canvas',

    rowLengthCache: [],

    searchString: null,

    // tracks how many cursor toggles since the last full repaint
    toggleCursorFullRepaintCounter: 0,

    // number of milliseconds between cursor blink
    toggleCursorFrequency: 250,

    // is the cursor allowed to toggle? (used by cursorManager.moveCursor)
    toggleCursorAllowed: true,

    horizontalScrollCanvas: null,
    verticalScrollCanvas: null,

    // gutterWidth used to be a constant, but is now dynamically calculated in each paint() invocation. I set it to a silly
    // default value here in case some of the code expects it to be populated before the first paint loop kicks in. the
    // default value ought to eventually become 0
    gutterWidth: 54,

    LINE_HEIGHT: 23,

    BOTTOM_SCROLL_AFFORDANCE: 30,

    GUTTER_INSETS: { top: 0, left: 6, right: 10, bottom: 6 },

    LINE_INSETS: { top: 0, left: 5, right: 0, bottom: 6 },

    FALLBACK_CHARACTER_WIDTH: 10,

    NIB_WIDTH: 15,

    NIB_INSETS: {
        top: Math.floor(15 / 2),
        left: Math.floor(15 / 2),
        right: Math.floor(15 / 2),
        bottom: Math.floor(15 / 2)
    },

    NIB_ARROW_INSETS: { top: 3, left: 3, right: 3, bottom: 5 },

    DEBUG_GUTTER_WIDTH: 18,

    DEBUG_GUTTER_INSETS: { top: 2, left: 2, right: 2, bottom: 2 },

    // number of pixels to translate the canvas for scrolling
    xoffset: 0,
    yoffset: 0,

    showCursor: true,

    xscrollbar: null,
    yscrollbar: null,

    overXScrollBar: false,
    overYScrollBar: false,

    hasFocus: false,

    // Some things need to happen only when we're rendered. This is how we delay
    onInitActions: [],
    inited: false,

    // painting optimization state
    lastLineCount: 0,
    lastCursorPos: null,
    lastxoffset: 0,
    lastyoffset: 0,

    init: function() {
        var settings = bespin.get("settings");

        var pluginCatalog = bespin.get("plugins");
        var ep = pluginCatalog.getExtensionPoint("syntax.engine");
        // set model to a default that will work until the real thing is loaded
        this.syntaxModel = syntax.Model.create();

        if (ep.extensions.length > 0) {
            ep.extensions[0].load(function(model) {
                this.syntaxModel = model.create();
            }.bind(this));
        }

        this.selectionHelper = SelectionHelper.create({ editor: this.editor });
        this.actions = actions.Actions.create({ editor: this.editor });

        // these two canvases are used as buffers for the scrollbar images,
        // which are then composited onto the main code view. we could have
        // saved ourselves some misery by just prerendering slices of the
        // scrollbars and combining them like sane people, but... meh
        this.horizontalScrollCanvas = document.createElement("canvas");
        this.verticalScrollCanvas = document.createElement('canvas');

        // this.lineHeight;        // reserved for when line height is calculated dynamically instead of with a constant; set first time a paint occurs
        // this.charWidth;         // set first time a paint occurs
        // this.visibleRows;       // the number of rows visible in the editor; set each time a paint occurs
        // this.firstVisibleRow;   // first row that is visible in the editor; set each time a paint occurs

        // this.nibup;             // rect
        // this.nibdown;           // rect
        // this.nibleft;           // rect
        // this.nibright;          // rect

        // this.selectMouseDownPos;        // position when the user moused down
        // this.selectMouseDetail;         // the detail (number of clicks) for the mouse down.

        // In the old Bespin, if we acted as a component, the onmousewheel
        // should only be listened to inside of the editor canvas. In the new
        // world where everything builds off the embedded bespin, we should work
        // out what to do with a failed scroll when we find it.
        // var scope = this.editor.actsAsComponent ? this.editor.canvas : window;
        // And we don't need it here. And it wouldn't work anyway
        // var scope = this.editor.canvas;

        var xscrollbar = scroller.Scrollbar.create({
            ui: this,
            orientation: "horizontal",
            valueChanged: function() {
                var ui = this.ui;
                ui.xoffset = - ui.xscrollbar.value;
                ui.editor.paint();
            }
        });
        this.xscrollbar = xscrollbar;

        var wheelEventName = (window.onmousewheel ? "onmousewheel" : "DOMMouseScroll");

        // More event handlers
        // gh.push(dojo.connect(window, "mousemove", xscrollbar, "onmousemove"));
        // gh.push(dojo.connect(window, "mouseup", xscrollbar, "onmouseup"));
        // gh.push(dojo.connect(scope, wheelEventName, xscrollbar, "onmousewheel"));

        var yscrollbar = scroller.Scrollbar.create({
            ui: this,
            orientation: "vertical",
            valueChanged: function() {
                var ui = this.ui;
                ui.yoffset = -ui.yscrollbar.value;
                ui.editor.paint();
            }
        });
        this.yscrollbar = yscrollbar;

        // Still more event handlers
        // gh.push(dojo.connect(window, "mousemove", yscrollbar, "onmousemove"));
        // gh.push(dojo.connect(window, "mouseup", yscrollbar, "onmouseup"));
        // gh.push(dojo.connect(scope, wheelEventName, yscrollbar, "onmousewheel"));

        setTimeout(function() {
            this.toggleCursor();
        }.bind(this), this.toggleCursorFrequency);

        this.sc_super();
    },

    render: function(context, firstTime) {
        // TODO: Shouldn't we only do this if !firstTime
        context.attr('moz-opaque', 'true');
        context.attr("tabindex", "1");
        context.push('canvas tag not supported by your browser');
    },

    didCreateLayer: function() {
        var canvas = this.$()[0];
        this.set("canvas", canvas);

        SC.Event.add(canvas, "blur", this, function(ev) {
            this.focus = true;
            return true;
        });

        SC.Event.add(canvas, "focus", this, function(ev) {
            this.focus = true;
            return true;
        });

        // Nail the clipboard
        var editorWrapper = EditorWrapper.create({
            editor: this.editor,
            ui: this
        });
        clipboard.setup(editorWrapper);

        // TODO: There has to be a better way for the controller to know
        // when it's safe to call installKeyListener() than this...
        this.onInitActions.forEach(function(action) {
            action();
        });
        this.inited = true;
    },

    onInit: function(action) {
        if (this.inited) {
            action();
            return;
        }
        this.onInitActions.push(action);
    },

    /**
     * col is -1 if user clicked in gutter; clicking below last line maps to last line
     */
    convertClientPointToCursorPoint: function(pos) {
        var settings = bespin.get("settings");
        var x, y;

        var content = this.get("content");

        if (pos.y < 0) { //ensure line >= first
            y = 0;
        } else if (pos.y >= (this.lineHeight * content.getRowCount())) { //ensure line <= last
            y = content.getRowCount() - 1;
        } else {
            var ty = pos.y;
            y = Math.floor(ty / this.lineHeight);
        }

        if (pos.x <= (this.gutterWidth + this.LINE_INSETS.left)) {
            x = -1;
        } else {
            var tx = pos.x - this.gutterWidth - this.LINE_INSETS.left;
            // round vs floor so we can pick the left half vs right half of a character
            x = Math.round(tx / this.charWidth);

            // With strictlines turned on, don't select past the end of the line
            if ((settings && settings.isSettingOn('strictlines'))) {
                var maxcol = this.getRowScreenLength(y);

                if (x >= maxcol) {
                    x = this.getRowScreenLength(y);
                }
            }
        }
        return { row: y, col: x };
    },

    setSelection: function(e) {
        var content = this.get("content");
        var clientY = e.clientY - this.getTopOffset();
        var clientX = e.clientX - this.getLeftOffset();

        if (!this.selectMouseDownPos) {
            return;
        }

        var down = cursor.copyPos(this.selectMouseDownPos);

        var point = { x: clientX, y: clientY };
        point.x += Math.abs(this.xoffset);
        point.y += Math.abs(this.yoffset);
        var up = this.convertClientPointToCursorPoint(point);

        if (down.col == -1) {
            down.col = 0;
            // clicked in gutter; show appropriate lineMarker message
            var lineMarker = bespin.get("parser").getLineMarkers()[down.row + 1];
            if (lineMarker) {
                bespin.get("commandLine").showHint(lineMarker.msg);
            }
        }
        if (up.col == -1) {
            up.col = 0;
        }

        //we'll be dealing with the model directly, so we need model positions.
        var modelstart = this.editor.getModelPos(down);
        var modelend = this.editor.getModelPos(up);

        //to make things simpler, go ahead and check if it is reverse
        var backwards = false;
        if (modelend.row < modelstart.row || (modelend.row == modelstart.row && modelend.col < modelstart.col)) {
            backwards = true; //need to know so that we can maintain direction for shift-click select

            var temp = modelstart;
            modelstart = modelend;
            modelend = temp;
        }

        //validate
        if (!content.hasRow(modelstart.row)) {
            modelstart.row = content.getRowCount() - 1;
        }

        if (!content.hasRow(modelend.row)) {
            modelend.row = content.getRowCount() - 1;
        }

        //get detail
        var detail = this.selectMouseDetail;
        var startPos, endPos;

        //single click
        if (detail == 1) {
            if (cursor.posEquals(modelstart, modelend)) {
                this.editor.setSelection(undefined);
            } else {
                //we could use raw "down" and "up", but that would skip validation.
                this.editor.setSelection({
                    startPos: this.editor.getCursorPos(backwards ? modelend : modelstart),
                    endPos: this.editor.getCursorPos(backwards ? modelstart : modelend)
                });
            }

            this.editor.moveCursor(this.editor.getCursorPos(backwards ? modelstart : modelend));
        } else if (detail == 2) { //double click
            var row = content.rows[modelstart.row];
            var cursorAt = row[modelstart.col];

            // the following is an ugly hack. We should have a syntax-specific set of "delimiter characters"
            // which are treated like whitespace for findBefore and findAfter.
            // to keep it at least a LITTLE neat, I have moved the comparator for double-click into its own function,
            // and have left model alone.
            var isDelimiter = function(item) {
                var delimiters = ["=", " ", "\t", ">", "<", ".", "(", ")", "{", "}", ":", '"', "'", ";"];
                if (delimiters.indexOf(item) > -1) {
                    return true;
                }
                return false;
            };

            var comparator;
            if (!cursorAt) {
                // nothing to see here. We must be past the end of the line.
                // Per Gordon's suggestion, let's have double-click EOL select the line, excluding newline
                this.editor.setSelection({
                    startPos: this.editor.getCursorPos({row: modelstart.row, col: 0}),
                    endPos: this.editor.getCursorPos({row: modelstart.row, col: row.length})
                });
            } else if (isDelimiter(cursorAt.charAt(0))) { // see above. Means empty space or =, >, <, etc. that we want to be clever with
                comparator = function(letter) {
                    if (isDelimiter(letter)) {
                        return false;
                    }
                    return true;
                };

                startPos = content.findBefore(modelstart.row, modelstart.col, comparator);
                endPos = content.findAfter(modelend.row, modelend.col, comparator);

                this.editor.setSelection({
                    startPos: this.editor.getCursorPos(backwards ? endPos : startPos),
                    endPos: this.editor.getCursorPos(backwards ? startPos : endPos)
                });

                //set cursor so that it is at selection end (even if mouse wasn't there)
                this.editor.moveCursor(this.editor.getCursorPos(backwards ? startPos : endPos));
            } else {
                comparator = function(letter) {
                    if (isDelimiter(letter)) {
                        return true;
                    }
                    return false;
                };

                startPos = content.findBefore(modelstart.row, modelstart.col, comparator);
                endPos = content.findAfter(modelend.row, modelend.col, comparator);

                this.editor.setSelection({
                    startPos: this.editor.getCursorPos(backwards ? endPos : startPos),
                    endPos: this.editor.getCursorPos(backwards ? startPos : endPos)
                });

                //set cursor so that it is at selection end (even if mouse wasn't there)
                this.editor.moveCursor(this.editor.getCursorPos(backwards ? startPos : endPos));
            }
        } else if (detail > 2) { //triple plus duluxe
            // select the line
            startPos = {row: modelstart.row, col: 0};
            endPos = {row: modelend.row, col: 0};
            if (this.editor.model.hasRow(endPos.row + 1)) {
                endPos.row = endPos.row + 1;
            } else {
                endPos.col = this.editor.model.getRowArray(endPos.row).length;
            }

            startPos = this.editor.getCursorPos(startPos);
            endPos = this.editor.getCursorPos(endPos);

            this.editor.setSelection({
                startPos: backwards ? endPos : startPos,
                endPos: backwards ? startPos: endPos
            });
            this.editor.moveCursor(backwards ? startPos : endPos);
        }

        //finally, and the LAST thing we should do (otherwise we'd mess positioning up)
        //scroll down, up, right, or left a bit if needed.

        //up and down. optimally, we should have a timeout or something to keep checking...
        if (clientY < 0) {
            this.yoffset = Math.min(1, this.yoffset + (-clientY));
        } else if (clientY >= this.getHeight()) {
            var virtualHeight = this.lineHeight * this.editor.model.getRowCount();
            this.yoffset = Math.max(-(virtualHeight - this.getHeight() - this.BOTTOM_SCROLL_AFFORDANCE), this.yoffset - clientY - this.getHeight());
        }

        this.editor.paint();
    },

    toggleCursor: function() {
        if (this.toggleCursorAllowed) {
            this.showCursor = !this.showCursor;
        } else {
            this.toggleCursorAllowed = true;
        }

        if (++this.toggleCursorFullRepaintCounter > 0) {
            this.toggleCursorFullRepaintCounter = 0;
            this.editor.paint(true);
        } else {
            this.editor.paint();
        }

        // Trigger this to kick off again soon
        setTimeout(function() {
            this.toggleCursor();
        }.bind(this), this.toggleCursorFrequency);
    },

    ensureCursorVisible: function(softEnsure) {
        var content = this.get("content");
        if ((!this.lineHeight) || (!this.charWidth)) {
            return;    // can't do much without these
        }

        var pageScroll;
        if (bespin.get('settings')) {
            pageScroll = parseFloat(bespin.get('settings').pagescroll) || 0;
        } else {
            pageScroll = 0;
        }
        pageScroll = (!softEnsure ? Math.max(0, Math.min(1, pageScroll)) : 0.25);

        var y = this.lineHeight * this.editor.cursorManager.getCursorPosition().row;
        var x = this.charWidth * this.editor.cursorManager.getCursorPosition().col;

        var cheight = this.getHeight();
        var cwidth = this.getWidth() - this.gutterWidth;

        if (Math.abs(this.yoffset) > y) {               // current row before top-most visible row
            this.yoffset = Math.min(-y + cheight * pageScroll, 0);
        } else if ((Math.abs(this.yoffset) + cheight) < (y + this.lineHeight)) {       // current row after bottom-most visible row
            this.yoffset = -((y + this.lineHeight) - cheight * (1 - pageScroll));
            this.yoffset = Math.max(this.yoffset, cheight - this.lineHeight * content.getRowCount());
        }

        if (Math.abs(this.xoffset) > x) {               // current col before left-most visible col
            this.xoffset = -x;
        } else if ((Math.abs(this.xoffset) + cwidth) < (x + (this.charWidth * 2))) { // current col after right-most visible col
            this.xoffset = -((x + (this.charWidth * 2)) - cwidth);
        }
    },

    /**
     * TODO: Is this ever called?
     */
    handleFocus: function(e) {
        var content = this.get("content");
        content.clear();
        content.insertCharacters({ row: 0, col: 0 }, e.type);
        return true;
    },

    mouseDragged: function(e) {
        if (this.selectMouseDownPos) {
            this.setSelection(e);
        }
        return true;
    },

    mouseDown: function(e) {
        var clientY = e.clientY - this.getTopOffset();
        var clientX = e.clientX - this.getLeftOffset();

        if (this.overXScrollBar || this.overYScrollBar) {
            return true;
        }

        var point;
        if (this.editor.debugMode) {
            if (clientX < this.DEBUG_GUTTER_WIDTH) {
                console.log("Clicked in debug gutter");
                point = { x: clientX, y: clientY };
                point.y += Math.abs(this.yoffset);
                var p = this.convertClientPointToCursorPoint(point);

                var editSession = bespin.get("editSession");
                if (p && editSession) {
                    bespin.getComponent("breakpoints", function(breakpoints) {
                        breakpoints.toggleBreakpoint({ project: editSession.project, path: editSession.path, lineNumber: p.row });
                        this.editor.paint(true);
                    }, this);
                }
                return true;
            }
        }

        this.selectMouseDetail = e.detail;
        if (e.shiftKey) {
            this.selectMouseDownPos = (this.editor.selection) ? this.editor.selection.startPos : this.editor.getCursorPos();
            this.setSelection(e);
        } else {
            point = { x: clientX, y: clientY };

            // happens first, because scroll bars are not relative to scroll position
            if ((this.xscrollbar.rect.contains(point)) || (this.yscrollbar.rect.contains(point))) {
                return true;
            }

            // now, compensate for scroll position.
            point.x += Math.abs(this.xoffset);
            point.y += Math.abs(this.yoffset);

            this.selectMouseDownPos = this.convertClientPointToCursorPoint(point);
        }

        // I'm not sure why we should need to manually set focus to the canvas;
        // it happens automatically when there is no mouseDown event handler
        this.get('canvas').focus();

        return this.handleMouse(e);
    },

    mouseUp: function(e) {
        if (this.selectMouseDownPos) {
            this.setSelection(e);
            this.selectMouseDownPos = undefined;
            this.selectMouseDetail = undefined;
            return false;
        }

        return true;
    },

    click: function(e) {
        e.type = "click";
        return this.handleMouse(e);
    },

    handleMouse: function(e) {
        /*
        // Right click for pie menu
        if (e.button == 2) {
            bespin.getComponent("piemenu", function(piemenu) {
                piemenu.show(null, false, e.clientX, e.clientY);
            });
            return false;
        }
        */

        var clientY = e.clientY - this.getTopOffset();
        var clientX = e.clientX - this.getLeftOffset();

        var oldX = this.overXScrollBar;
        var oldY = this.overYScrollBar;
        var scrolled = false;

        var w = this.editor.container.clientWidth;
        var h = this.editor.container.clientHeight;
        var sx = w - this.NIB_WIDTH - this.NIB_INSETS.right;    // x start of the vert. scroll bar
        var sy = h - this.NIB_WIDTH - this.NIB_INSETS.bottom;   // y start of the hor. scroll bar

        var p = { x: clientX, y:clientY };

        if (e.type == "mousedown") {
            // dispatch to the scrollbars
            if ((this.xscrollbar) && (this.xscrollbar.rect.contains(p))) {
                this.xscrollbar.onmousedown(e);
            } else if ((this.yscrollbar) && (this.yscrollbar.rect.contains(p))) {
                this.yscrollbar.onmousedown(e);
            }
        }

        if (e.type == "mouseout") {
            this.overXScrollBar = false;
            this.overYScrollBar = false;
        }

        if ((e.type == "mousemove") || (e.type == "click")) {
            //and only true IF the scroll bar is visible, obviously.
            this.overYScrollBar = (p.x > sx) && this.yscrollbarVisible;
            this.overXScrollBar = (p.y > sy) && this.xscrollbarVisible;
        }

        var nibup = this.nibup;
        var nibdown = this.nibdown;
        var nibleft = this.nibleft;
        var nibright = this.nibright;

        if (e.type == "click") {
            if ((typeof e.button != "undefined") && (e.button == 0)) {
                var button;
                if (nibup.contains(p)) {
                    button = "up";
                } else if (nibdown.contains(p)) {
                    button = "down";
                } else if (nibleft.contains(p)) {
                    button = "left";
                } else if (nibright.contains(p)) {
                    button = "right";
                }

                if (button == "up") {
                    this.yoffset += this.lineHeight;
                    scrolled = true;
                } else if (button == "down") {
                    this.yoffset -= this.lineHeight;
                    scrolled = true;
                } else if (button == "left") {
                    this.xoffset += this.charWidth * 2;
                    scrolled = true;
                } else if (button == "right") {
                    this.xoffset -= this.charWidth * 2;
                    scrolled = true;
                }
            }
        }

        // Mousing over the scroll bars requires a full refresh
        if ((oldX != this.overXScrollBar) || (oldY != this.overYScrollBar) || scrolled) {
            this.editor.paint(true);
        }

        return true;
    },

    /**
     *
     */
    setFocus: function(focus) {
        this.onInit(function() {
            if (this.focus != focus) {
                var canvas = this.get('canvas');
                if (focus) {
                    canvas.focus();
                } else {
                    canvas.blur();
                }
                this.focus = focus;
            }
        }.bind(this));
    },

    /**
     *
     */
    hasFocus: function(focus) {
        return this.focus;
    },

    /**
     * Accessor for the DOM element to which we attach keyboard event handlers.
     * This could be seen as leakage of implementation details, so please
     * document usage of this function here.
     * <p>Used by clipboard.js to adding cut and paste hacks
     */
    _getFocusElement: function() {
        return this.get('canvas');
    },

    /**
     *
     */
    installKeyListener: function(listener) {
        this.onInit(function() {
            this.realInstallKeyListener(listener);
        }.bind(this));
    },

    realInstallKeyListener: function(listener) {
        // TODO: Why would we ever want to take over keypresses for the whole
        // window????
        // var scope = this.editor.opts.actsAsComponent ? this.editor.canvas : window;
        var scope = this.get('canvas');

        if (this.oldkeydown) {
            SC.Event.remove(scope, "keydown", this, this.oldkeydown);
        }
        if (this.oldkeypress) {
            SC.Event.remove(scope, "keypress", this, this.oldkeypress);
        }

        this.oldkeydown = function(ev) {
            listener.onkeydown(ev);
            return true;
        };
        this.oldkeypress = function(ev) {
            listener.onkeypress(ev);
            return true;
        };

        SC.Event.add(scope, "keydown", this, this.oldkeydown);
        SC.Event.add(scope, "keypress", this, this.oldkeypress);

        var Key = keys.Key;

        // Modifiers, Key, Action
        listener.bindKeyStringSelectable("", keys.Key.LEFT_ARROW, this.actions.moveCursorLeft, "Move Cursor Left");
        listener.bindKeyStringSelectable("", keys.Key.RIGHT_ARROW, this.actions.moveCursorRight, "Move Cursor Right");
        listener.bindKeyStringSelectable("", keys.Key.UP_ARROW, this.actions.moveCursorUp, "Move Cursor Up");
        listener.bindKeyStringSelectable("", keys.Key.DOWN_ARROW, this.actions.moveCursorDown, "Move Cursor Down");

        // Move Left: Mac = Alt+Left, Win/Lin = Ctrl+Left
        listener.bindKeyForPlatform({
            MAC: "ALT LEFT_ARROW",
            WINDOWS: "CTRL LEFT_ARROW"
        }, this.actions.moveWordLeft, "Move Word Left", true /* selectable */);

        // Move Right: Mac = Alt+Right, Win/Lin = Ctrl+Right
        listener.bindKeyForPlatform({
            MAC: "ALT RIGHT_ARROW",
            WINDOWS: "CTRL RIGHT_ARROW"
        }, this.actions.moveWordRight, "Move Word Right", true /* selectable */);

        // Start of line: All platforms support HOME. Mac = Apple+Left, Win/Lin = Alt+Left
        listener.bindKeyStringSelectable("", keys.Key.HOME, this.actions.moveToLineStart, "Move to start of line");
        listener.bindKeyForPlatform({
            MAC: "APPLE LEFT_ARROW",
            WINDOWS: "ALT LEFT_ARROW"
        }, this.actions.moveToLineStart, "Move to start of line", true /* selectable */);

        // End of line: All platforms support END. Mac = Apple+Right, Win/Lin = Alt+Right
        listener.bindKeyStringSelectable("", keys.Key.END, this.actions.moveToLineEnd, "Move to end of line");
        listener.bindKeyForPlatform({
            MAC: "APPLE RIGHT_ARROW",
            WINDOWS: "ALT RIGHT_ARROW"
        }, this.actions.moveToLineEnd, "Move to end of line", true /* selectable */);

        listener.bindKeyString("CTRL", keys.Key.K, this.actions.killLine, "Kill entire line");
        listener.bindKeyString("CMD", keys.Key.L, this.actions.gotoLine, "Goto Line");
        listener.bindKeyString("CTRL", keys.Key.L, this.actions.moveCursorRowToCenter, "Move cursor to center of page");

        listener.bindKeyStringSelectable("", keys.Key.BACKSPACE, this.actions.backspace, "Backspace");
        listener.bindKeyStringSelectable("CTRL", keys.Key.BACKSPACE, this.actions.deleteWordLeft, "Delete a word to the left");

        listener.bindKeyString("", keys.Key.DELETE, this.actions.deleteKey, "Delete");
        listener.bindKeyString("CTRL", keys.Key.DELETE, this.actions.deleteWordRight, "Delete a word to the right");

        listener.bindKeyString("", keys.Key.ENTER, this.actions.newline, "Insert newline");
        listener.bindKeyString("CMD", keys.Key.ENTER, this.actions.newlineBelow, "Insert newline at end of current line");
        listener.bindKeyString("", keys.Key.TAB, this.actions.insertTab, "Indent / insert tab");
        listener.bindKeyString("SHIFT", keys.Key.TAB, this.actions.unindent, "Unindent");
        listener.bindKeyString("CMD", keys.Key.SQUARE_BRACKET_CLOSE, this.actions.indent, "Indent");
        listener.bindKeyString("CMD", keys.Key.SQUARE_BRACKET_OPEN, this.actions.unindent, "Unindent");

        listener.bindKeyString("", keys.Key.ESCAPE, this.actions.escape, "Clear fields and dialogs");

        listener.bindKeyString("CMD", keys.Key.A, this.actions.selectAll, "Select All");

        // handle key to jump between editor and other windows / commandline
        listener.bindKeyString("CMD", keys.Key.I, this.actions.toggleQuickopen, "Toggle Quickopen");
        listener.bindKeyString("CMD", keys.Key.J, this.actions.focusCommandline, "Open Command line");
        listener.bindKeyString("CMD", keys.Key.O, this.actions.focusFileBrowser, "Open File Browser");
        listener.bindKeyString("CMD", keys.Key.F, this.actions.cmdFilesearch, "Search in this file");
        listener.bindKeyString("CMD", keys.Key.G, this.actions.findNext, "Find Next");
        listener.bindKeyString("SHIFT CMD", keys.Key.G, this.actions.findPrev, "Find Previous");
        listener.bindKeyString("CTRL", keys.Key.M, this.actions.togglePieMenu, "Open Pie Menu");

        listener.bindKeyString("CMD", keys.Key.Z, this.actions.undo, "Undo");
        listener.bindKeyString("SHIFT CMD", keys.Key.Z, this.actions.redo, "Redo");
        listener.bindKeyString("CMD", keys.Key.Y, this.actions.redo, "Redo");

        listener.bindKeyStringSelectable("CMD", keys.Key.UP_ARROW, this.actions.moveToFileTop, "Move to top of file");
        listener.bindKeyStringSelectable("CMD", keys.Key.DOWN_ARROW, this.actions.moveToFileBottom, "Move to bottom of file");
        listener.bindKeyStringSelectable("CMD", keys.Key.HOME, this.actions.moveToFileTop, "Move to top of file");
        listener.bindKeyStringSelectable("CMD", keys.Key.END, this.actions.moveToFileBottom, "Move to bottom of file");

        listener.bindKeyStringSelectable("", keys.Key.PAGE_UP, this.actions.movePageUp, "Move a page up");
        listener.bindKeyStringSelectable("", keys.Key.PAGE_DOWN, this.actions.movePageDown, "Move a page down");

        // For now we are punting and doing a page down, but in the future we will tie to outline mode and move in block chunks
        listener.bindKeyStringSelectable("ALT", keys.Key.UP_ARROW, this.actions.movePageUp, "Move up a block");
        listener.bindKeyStringSelectable("ALT", keys.Key.DOWN_ARROW, this.actions.movePageDown, "Move down a block");

        listener.bindKeyString("CMD ALT", keys.Key.LEFT_ARROW, this.actions.previousFile);
        listener.bindKeyString("CMD ALT", keys.Key.RIGHT_ARROW, this.actions.nextFile);

        // Other key bindings can be found in commands themselves.
        // For example, this:
        // Refactor warning: Below used to have an action - publish to "editor:newfile",
        // cahnged to this.editor.newfile but might not work as assumed.
        // listener.bindKeyString("CTRL SHIFT", keys.Key.N, this.editor.newfile, "Create a new file");
        // has been moved to the 'newfile' command withKey
        // Also, the clipboard.js handles C, V, and X
    },

    getWidth: function() {
        var styles = window.getComputedStyle(this.editor.container, null);
        return parseInt(styles.width, 10);
    },

    getHeight: function() {
        var styles = window.getComputedStyle(this.editor.container, null);
        return parseInt(styles.height, 10);
    },

    /**
     *
     */
    getTopOffset: function() {
        // If getBoundingClientRect() fails then we might need to use a library
        // function or this.editor.container.offsetTop
        return this.editor.container.getBoundingClientRect().top;
    },

    getLeftOffset: function() {
        // If getBoundingClientRect() fails then we might need to use a library
        // function or this.editor.container.offsetLeft
        return this.editor.container.getBoundingClientRect().left;
    },

    getCharWidth: function(ctx) {
        if (ctx.measureText) {
            return ctx.measureText("M").width;
        } else {
            return this.FALLBACK_CHARACTER_WIDTH;
        }
    },

    getLineHeight: function(ctx) {
        var lh = -1;
        if (ctx.measureText) {
            var t = ctx.measureText("M");
            if (t.ascent) {
                lh = Math.floor(t.ascent * 2.8);
            }
        }
        if (lh == -1) {
            lh = this.LINE_HEIGHT;
        }
        return lh;
    },

    /**
     * Forces a resize of the canvas
     */
    resetCanvas: function() {
        this.editor.canvas.width = this.getWidth();
        this.editor.canvas.height = this.getHeight();
    },

    /**
     * Wrap the normal fillText for the normal case
     */
    fillText: function(ctx, text, x, y) {
        ctx.fillText(text, x, y);
    },

    /**
     * Set the transparency to 30% for the fillText (e.g. readonly mode uses this)
     */
    fillTextWithTransparency: function(ctx, text, x, y) {
        ctx.globalAlpha = 0.3;
        ctx.fillText(text, x, y);
        ctx.globalAlpha = 1.0;
    },

    /**
     * This is where the editor is painted from head to toe.
     * The optional "fullRefresh" argument triggers a complete repaint of the
     * editor canvas; otherwise, pitiful tricks are used to draw as little as possible.
     */
    paint: function(ctx, fullRefresh) {
        var content = this.get("content");

        // these are convenience references so we don't have to type so much
        var ed = this.editor;
        var c = this.get('canvas');
        var theme = ed.theme;

        // these are commonly used throughout the rendering process so are defined up here to make it clear they are shared
        var x, y;
        var cy;
        var currentLine;
        var lastLineToRender;

        var Rect = scroller.Rect;

        // SETUP STATE
        // if the user explicitly requests a full refresh, give it to 'em
        var refreshCanvas = fullRefresh;

        if (!refreshCanvas) {
            refreshCanvas = (this.selectMouseDownPos);
        }

        if (!refreshCanvas) {
            // if the line count has changed, full refresh
            refreshCanvas = (this.lastLineCount != content.getRowCount());
        }

        // save the number of lines for the next time paint
        this.lastLineCount = content.getRowCount();

        // get the line and character metrics; calculated for each paint because
        // this value can change at run-time
        ctx.font = theme.editorTextFont;
        this.charWidth = this.getCharWidth(ctx);
        this.lineHeight = this.getLineHeight(ctx);

        // cwidth and cheight are set to the dimensions of the parent node of
        // the canvas element; we'll resize the canvas element
        // itself a little bit later in this function
        var cwidth = this.getWidth();
        var cheight = this.getHeight();

        // adjust the scrolling offsets if necessary; negative values are good,
        // indicate scrolling down or to the right (we look for overflows on
        // these later on)
        // positive values are bad; they indicate scrolling up past the first
        // line or to the left past the first column
        if (this.xoffset > 0) {
            this.xoffset = 0;
        }
        if (this.yoffset > 0) {
            this.yoffset = 0;
        }

        // only paint those lines that can be visible
        this.visibleRows = Math.ceil(cheight / this.lineHeight);
        this.firstVisibleRow = Math.floor(Math.abs(this.yoffset / this.lineHeight));
        lastLineToRender = this.firstVisibleRow + this.visibleRows;
        if (lastLineToRender > (content.getRowCount() - 1)) {
            lastLineToRender = content.getRowCount() - 1;
        }

        // full height based on content
        var virtualheight = this.lineHeight * content.getRowCount();

        // virtual width *should* be based on every line in the model; however,
        // with the introduction of tab support, calculating
        // the width of a line is now expensive, so for the moment we will only
        // calculate the width of the visible rows
        // full width based on content plus a little padding
        // var virtualwidth = this.charWidth * (Math.max(this.getMaxCols(), ed.cursorManager.getCursorPosition().col) + 2);
        var virtualwidth = this.charWidth * (Math.max(this.getMaxCols(this.firstVisibleRow, lastLineToRender), ed.cursorManager.getCursorPosition().col) + 2);

        // calculate the gutter width; for now, we'll make it fun and dynamic
        // based on the lines visible in the editor.
        // first, add the padding space
        this.gutterWidth = this.GUTTER_INSETS.left + this.GUTTER_INSETS.right;
        // make it wide enough to display biggest line number visible
        this.gutterWidth += ("" + lastLineToRender).length * this.charWidth;
        if (this.editor.debugMode) {
            this.gutterWidth += this.DEBUG_GUTTER_WIDTH;
        }

        // these next two blocks make sure we don't scroll too far in either the
        // x or y axis
        if (this.xoffset < 0) {
            if ((Math.abs(this.xoffset)) > (virtualwidth - (cwidth - this.gutterWidth))) {
                this.xoffset = (cwidth - this.gutterWidth) - virtualwidth;
            }
        }
        if (this.yoffset < 0) {
            if ((Math.abs(this.yoffset)) > (virtualheight - (cheight - this.BOTTOM_SCROLL_AFFORDANCE))) {
                this.yoffset = cheight - (virtualheight - this.BOTTOM_SCROLL_AFFORDANCE);
            }
        }

        // if the current scrolled positions are different than the scroll
        // positions we used for the last paint, refresh the entire canvas
        if ((this.xoffset != this.lastxoffset) || (this.yoffset != this.lastyoffset)) {
            refreshCanvas = true;
            this.lastxoffset = this.xoffset;
            this.lastyoffset = this.yoffset;
        }

        // these are boolean values indicating whether the x and y
        // (i.e., horizontal or vertical) scroll bars are visible
        var xscroll = ((cwidth - this.gutterWidth) < virtualwidth);
        var yscroll = (cheight < virtualheight);

        // the scroll bars are rendered off-screen into their own canvas
        // instances; these values are used in two ways as part of
        // this process:
        //   1. the x pos of the vertical scroll bar image when painted onto the
        //      canvas and the y pos of the horizontal scroll bar image (both
        //      images span 100% of the width/height in the other dimension)
        //   2. the amount * -1 to translate the off-screen canvases used by the
        //      scrollbars; this lets us flip back to rendering the scroll bars
        //      directly on the canvas with relative ease (by omitted the
        //      translations and passing in the main context reference instead
        //      of the off-screen canvas context)
        var verticalx = cwidth - this.NIB_WIDTH - this.NIB_INSETS.right - 2;
        var horizontaly = cheight - this.NIB_WIDTH - this.NIB_INSETS.bottom - 2;

        // these are boolean values that indicate whether special little "nibs"
        // should be displayed indicating more content to the left, right, top,
        // or bottom
        var showLeftScrollNib = (xscroll && (this.xoffset != 0));
        var showRightScrollNib = (xscroll && (this.xoffset > ((cwidth - this.gutterWidth) - virtualwidth)));
        var showUpScrollNib = (yscroll && (this.yoffset != 0));
        var showDownScrollNib = (yscroll && (this.yoffset > (cheight - virtualheight)));

        // check and see if the canvas is the same size as its immediate parent
        // in the DOM; if not, resize the canvas
        if (c.width != cwidth || c.height != cheight) {
            // if the canvas changes size, we'll need a full repaint
            refreshCanvas = true;
            c.width = cwidth;
            c.height = cheight;
        }

        // get debug metadata
        // var breakpoints = {};
        // var lineMarkers = bespin.get("parser").getLineMarkers();

        if (this.editor.debugMode && bespin.get("editSession")) {
            bespin.getComponent("breakpoints", function(bpmanager) {
                var points = bpmanager.getBreakpoints(bespin.get('editSession').project, bespin.get('editSession').path);
                points.forEach(function(point) {
                    breakpoints[point.lineNumber] = point;
                });
            });
        }

        // IF YOU WANT TO FORCE A COMPLETE REPAINT OF THE CANVAS ON EVERY PAINT,
        // UNCOMMENT THE FOLLOWING LINE:
        //refreshCanvas = true;

        // START RENDERING

        // if we're not doing a full repaint, work out which rows are "dirty"
        // and need to be repainted
        if (!refreshCanvas) {
            var dirty = content.getDirtyRows();

            // if the cursor has changed rows since the last paint, consider the previous row dirty
            if ((this.lastCursorPos) &&
                (this.lastCursorPos.row != ed.cursorManager.getCursorPosition().row)) {
                dirty[this.lastCursorPos.row] = true;
            }

            // we always repaint the current line
            dirty[ed.cursorManager.getCursorPosition().row] = true;
        }

        // save this state for the next paint attempt (see above for usage)
        this.lastCursorPos = cursor.copyPos(ed.cursorManager.getCursorPosition());

        // if we're doing a full repaint...
        if (refreshCanvas) {
            // ...paint the background color over the whole canvas and...
            ctx.fillStyle = theme.backgroundStyle;
            ctx.fillRect(0, 0, c.width, c.height);

            // ...paint the gutter
            ctx.fillStyle = theme.gutterStyle;
            ctx.fillRect(0, 0, this.gutterWidth, c.height);
        }

        // translate the canvas based on the scrollbar position; for now, just
        // translate the vertical axis
        // take snapshot of current context state so we can roll back later on
        ctx.save();

        // the Math.round(this.yoffset) makes the painting nice and not to go over 2 pixels
        // see for more informations:
        //  - https://developer.mozilla.org/en/Canvas_tutorial/Applying_styles_and_colors, section "Line styles"
        //  - https://developer.mozilla.org/@api/deki/files/601/=Canvas-grid.png
        ctx.translate(0, Math.round(this.yoffset));

        // paint the line numbers
        if (refreshCanvas) {
            //line markers first
            if (bespin.get("parser")) {
                for (currentLine = this.firstVisibleRow; currentLine <= lastLineToRender; currentLine++) {
                    if (lineMarkers[currentLine]) {
                        y = this.lineHeight * (currentLine - 1);
                        cy = y + (this.lineHeight - this.LINE_INSETS.bottom);
                        ctx.fillStyle = this.editor.theme["lineMarker" + lineMarkers[currentLine].type + "Color"];
                        ctx.fillRect(0, y, this.gutterWidth, this.lineHeight);
                    }
                 }
            }
            y = (this.lineHeight * this.firstVisibleRow);

            for (currentLine = this.firstVisibleRow; currentLine <= lastLineToRender; currentLine++) {
                x = 0;

                // if we're in debug mode...
                if (this.editor.debugMode) {
                    // ...check if the current line has a breakpoint
                    if (breakpoints[currentLine]) {
                        var bpx = x + this.DEBUG_GUTTER_INSETS.left;
                        var bpy = y + this.DEBUG_GUTTER_INSETS.top;
                        var bpw = this.DEBUG_GUTTER_WIDTH - this.DEBUG_GUTTER_INSETS.left - this.DEBUG_GUTTER_INSETS.right;
                        var bph = this.lineHeight - this.DEBUG_GUTTER_INSETS.top - this.DEBUG_GUTTER_INSETS.bottom;

                        var bpmidpointx = bpx + parseInt(bpw / 2, 10);
                        var bpmidpointy = bpy + parseInt(bph / 2, 10);

                        ctx.strokeStyle = "rgb(128, 0, 0)";
                        ctx.fillStyle = "rgb(255, 102, 102)";
                        ctx.beginPath();
                        ctx.arc(bpmidpointx, bpmidpointy, bpw / 2, 0, Math.PI*2, true);
                        ctx.closePath();
                        ctx.fill();
                        ctx.stroke();
                    }

                    // ...and push the line number to the right, leaving a space
                    // for breakpoint stuff
                    x += this.DEBUG_GUTTER_WIDTH;
                }

                x += this.GUTTER_INSETS.left;

                cy = y + (this.lineHeight - this.LINE_INSETS.bottom);

                ctx.fillStyle = theme.lineNumberColor;
                ctx.font = this.editor.theme.lineNumberFont;
                //console.log(currentLine + " " + x + " " + cy);
                ctx.fillText(currentLine + 1, x, cy);

                y += this.lineHeight;
            }
         }

        // and now we're ready to translate the horizontal axis; while we're at
        // it, we'll setup a clip to prevent any drawing outside
        // of code editor region itself (protecting the gutter). this clip is
        // important to prevent text from bleeding into the gutter.
        ctx.save();
        ctx.beginPath();
        ctx.rect(this.gutterWidth, -this.yoffset, cwidth - this.gutterWidth, cheight);
        ctx.closePath();
        ctx.translate(this.xoffset, 0);
        ctx.clip();

        // calculate the first and last visible columns on the screen; these
        // values will be used to try and avoid painting text that the user
        // can't actually see
        var firstColumn = Math.floor(Math.abs(this.xoffset / this.charWidth));
        var lastColumn = firstColumn + (Math.ceil((cwidth - this.gutterWidth) / this.charWidth));

        // create the state necessary to render each line of text
        y = (this.lineHeight * this.firstVisibleRow);
        // the starting column of the current region in the region render loop below
        var cc;
        // the ending column in the same loop
        var ce;
        // counter variable used for the same loop
        var ri;
        // length of the text in the region; used in the same loop
        var regionlen;
        var tx, tw, tsel;
        var settings = bespin.get("settings");
        var searchStringLength = (this.searchString ? this.searchString.length : -1);

        // paint each line
        for (currentLine = this.firstVisibleRow; currentLine <= lastLineToRender; currentLine++) {
            x = this.gutterWidth;

            // if we aren't repainting the entire canvas...
            if (!refreshCanvas) {
                // ...don't bother painting the line unless it is "dirty"
                // (see above for dirty checking)
                if (!dirty[currentLine]) {
                    y += this.lineHeight;
                    continue;
                }

                // setup a clip for the current line only; this makes drawing
                // just that piece of the scrollbar easy
                // this is restore()'d in another if (!refreshCanvas) block at
                // the end of the loop
                ctx.save();
                ctx.beginPath();
                ctx.rect(x + (Math.abs(this.xoffset)), y, cwidth, this.lineHeight);
                ctx.closePath();
                ctx.clip();

                // only repaint the line background if the zebra stripe won't be
                // painted into it
                if ((currentLine % 2) == 1) {
                    ctx.fillStyle = theme.backgroundStyle;
                    ctx.fillRect(x + (Math.abs(this.xoffset)), y, cwidth, this.lineHeight);
                }
            }

            // if highlight line is on, paint the highlight color
            if ((settings && settings.isSettingOn('highlightline')) &&
                    (currentLine == ed.cursorManager.getCursorPosition().row)) {
                ctx.fillStyle = theme.highlightCurrentLineColor;
                ctx.fillRect(x + (Math.abs(this.xoffset)), y, cwidth, this.lineHeight);
            // if not on highlight, see if we need to paint the zebra
            } else if ((currentLine % 2) == 0) {
                ctx.fillStyle = theme.zebraStripeColor;
                ctx.fillRect(x + (Math.abs(this.xoffset)), y, cwidth, this.lineHeight);
            }

            x += this.LINE_INSETS.left;
            cy = y + (this.lineHeight - this.LINE_INSETS.bottom);

            // paint the selection bar if the line has selections
            var selections = this.selectionHelper.getRowSelectionPositions(currentLine);
            if (selections) {
                tx = x + (selections.startCol * this.charWidth);
                tw = (selections.endCol == -1) ? (lastColumn - firstColumn) * this.charWidth : (selections.endCol - selections.startCol) * this.charWidth;
                ctx.fillStyle = theme.editorSelectedTextBackground;
                ctx.fillRect(tx, y, tw, this.lineHeight);
            }

            var lineMetadata = content.getRowMetadata(currentLine);
            var lineText = lineMetadata.lineText;
            var searchIndices = lineMetadata.searchIndices;

            // the following two chunks of code do the same thing; only one
            // should be uncommented at a time

            // CHUNK 1: this code just renders the line with white text and is for testing
            // ctx.fillStyle = "white";
            // ctx.fillText(this.editor.model.getRowArray(currentLine).join(""), x, cy);

            // CHUNK 2: this code uses the SyntaxModel API to render the line
            // syntax highlighting

            var lineInfo = this.syntaxModel.getSyntaxStylesPerLine(lineText, currentLine, this.editor.language);

            // Define a fill that is aware of the readonly attribute and fades out if applied
            var readOnlyAwareFill = ed.readonly ? this.fillTextWithTransparency : this.fillText;

            for (ri = 0; ri < lineInfo.regions.length; ri++) {
                var styleInfo = lineInfo.regions[ri];

                for (var style in styleInfo) {
                    if (!styleInfo.hasOwnProperty(style)) {
                        continue;
                    }

                    var thisLine = "";

                    var styleArray = styleInfo[style];
                    var currentColumn = 0; // current column, inclusive
                    for (var si = 0; si < styleArray.length; si++) {
                        var range = styleArray[si];

                        for ( ; currentColumn < range.start; currentColumn++) {thisLine += " ";}
                        thisLine += lineInfo.text.substring(range.start, range.stop);
                        currentColumn = range.stop;
                    }

                    ctx.fillStyle = this.editor.theme[style] || "white";
                    ctx.font = this.editor.theme.editorTextFont;
                    readOnlyAwareFill(ctx, thisLine, x, cy);
                }
            }

            // highlight search string
            if (searchIndices) {
                // in some cases the selections are -1 => set them to a more "realistic" number
                if (selections) {
                    tsel = { startCol: 0, endCol: lineText.length };
                    if (selections.startCol != -1) {
                        tsel.startCol = selections.startCol;
                    }
                    if (selections.endCol != -1) {
                        tsel.endCol = selections.endCol;
                    }
                } else {
                    tsel = false;
                }

                for (var i = 0; i < searchIndices.length; i++) {
                    var index = ed.cursorManager.getCursorPosition({col: searchIndices[i], row: currentLine}).col;
                    tx = x + index * this.charWidth;

                    // highlight the area
                    ctx.fillStyle = this.editor.theme.searchHighlight;
                    ctx.fillRect(tx, y, searchStringLength * this.charWidth, this.lineHeight);

                    // figure out, whether the selection is in this area. If so, colour it different
                    if (tsel) {
                        var indexStart = index;
                        var indexEnd = index + searchStringLength;

                        if (tsel.startCol < indexEnd && tsel.endCol > indexStart) {
                            indexStart = Math.max(indexStart, tsel.startCol);
                            indexEnd = Math.min(indexEnd, tsel.endCol);

                            ctx.fillStyle = this.editor.theme.searchHighlightSelected;
                            ctx.fillRect(x + indexStart * this.charWidth, y, (indexEnd - indexStart) * this.charWidth, this.lineHeight);
                        }
                    }

                    // print the overpainted text again
                    ctx.fillStyle = this.editor.theme.editorTextColor || "white";
                    ctx.fillText(lineText.substring(index, index + searchStringLength), tx, cy);
                }

            }

            // paint tab information, if applicable and the information should be displayed
            if (settings && (settings.isSettingOn("tabarrow") || settings.isSettingOn("tabshowspace"))) {
                if (lineMetadata.tabExpansions.length > 0) {
                    for (i = 0; i < lineMetadata.tabExpansions.length; i++) {
                        var expansion = lineMetadata.tabExpansions[i];

                        // the starting x position of the tab character; the existing value of y is fine
                        var lx = x + (expansion.start * this.charWidth);

                        // check if the user wants us to highlight tabs; useful if you need to mix tabs and spaces
                        var showTabSpace = settings && settings.isSettingOn("tabshowspace");
                        if (showTabSpace) {
                            var sw = (expansion.end - expansion.start) * this.charWidth;
                            ctx.fillStyle = this.editor.theme.tabSpace || "white";
                            ctx.fillRect(lx, y, sw, this.lineHeight);
                        }

                        var showTabNib = settings && settings.isSettingOn("tabarrow");
                        if (showTabNib) {
                            // the center of the current character position's bounding rectangle
                            cy = y + (this.lineHeight / 2);
                            var cx = lx + (this.charWidth / 2);

                            // the width and height of the triangle to draw representing the tab
                            tw = 4;
                            var th = 6;

                            // the origin of the triangle
                            tx = parseInt(cx - (tw / 2), 10);
                            var ty = parseInt(cy - (th / 2), 10);

                            // draw the rectangle
                            ctx.globalAlpha = 0.3; // make the tab arrow subtle
                            ctx.beginPath();
                            ctx.fillStyle = this.editor.theme.plain || "white";
                            ctx.moveTo(tx, ty);
                            ctx.lineTo(tx, ty + th);
                            ctx.lineTo(tx + tw, ty + parseInt(th / 2, 10));
                            ctx.closePath();
                            ctx.fill();
                            ctx.globalAlpha = 1.0;
                        }
                    }
                }
            }

            if (!refreshCanvas) {
                ctx.drawImage(this.verticalScrollCanvas, verticalx + Math.abs(this.xoffset), Math.abs(this.yoffset));
                ctx.restore();
            }

            y += this.lineHeight;
        }

        // paint the cursor
        if (this.focus) {
            if (this.showCursor) {
                if (ed.theme.cursorType == "underline") {
                    x = this.gutterWidth + this.LINE_INSETS.left + ed.cursorManager.getCursorPosition().col * this.charWidth;
                    y = (ed.getCursorPos().row * this.lineHeight) + (this.lineHeight - 5);
                    ctx.fillStyle = ed.theme.cursorStyle;
                    ctx.fillRect(x, y, this.charWidth, 3);
                } else {
                    x = this.gutterWidth + this.LINE_INSETS.left + ed.cursorManager.getCursorPosition().col * this.charWidth;
                    y = (ed.cursorManager.getCursorPosition().row * this.lineHeight);
                    ctx.fillStyle = ed.theme.cursorStyle;
                    ctx.fillRect(x, y, 1, this.lineHeight);
                }
            }
        } else {
            x = this.gutterWidth + this.LINE_INSETS.left + ed.cursorManager.getCursorPosition().col * this.charWidth;
            y = (ed.cursorManager.getCursorPosition().row * this.lineHeight);

            ctx.fillStyle = ed.theme.unfocusedCursorFillStyle;
            ctx.strokeStyle = ed.theme.unfocusedCursorStrokeStyle;
            ctx.fillRect(x, y, this.charWidth, this.lineHeight);
            ctx.strokeRect(x, y, this.charWidth, this.lineHeight);
        }

        // Paint the cursors of other users
        var session = bespin.get("editSession");
        if (session) {
            var userEntries = session.getUserEntries();
            if (userEntries) {
                userEntries.forEach(function(userEntry) {
                    if (!userEntry.clientData.isMe) {
                        x = this.gutterWidth + this.LINE_INSETS.left + userEntry.clientData.cursor.start.col * this.charWidth;
                        y = userEntry.clientData.cursor.start.row * this.lineHeight;
                        ctx.fillStyle = "#ee8c00";
                        ctx.fillRect(x, y, 1, this.lineHeight);
                        var prevFont = ctx.font;
                        ctx.font = "6pt Monaco, Lucida Console, monospace";
                        ctx.fillText(userEntry.handle, x + 3, y + this.lineHeight + 4);
                        ctx.font = prevFont;
                    }
                }.bind(this));
            }
        }

        // Paint the 'change' overlays. This is the polygon that we draw for
        // each change that has been reported to us in ui.setChanges()
        //                _____1__________
        //  _______3_____|2    _____7_____|8
        // |4_________5_______|6
        //
        if (this.changes) {
            this.changes.forEach(function(change) {
                // TODO: Make this part of the theme
                ctx.strokeStyle = "#211A16";
                ctx.beginPath();
                // Line 1 (starting at column 180 - should do better)
                x = this.gutterWidth + this.LINE_INSETS.left + 180 * this.charWidth;
                y = change.start.row * this.lineHeight;
                ctx.moveTo(x, y);
                x = this.gutterWidth + this.LINE_INSETS.left + change.start.col * this.charWidth;
                ctx.lineTo(x, y);
                // Line 2
                y += this.lineHeight;
                ctx.lineTo(x, y);
                // Line 3
                x = this.gutterWidth + this.LINE_INSETS.left;
                ctx.lineTo(x, y);
                // Line 4
                y = (change.end.row + 1) * this.lineHeight;
                ctx.lineTo(x, y);
                // Line 5
                x = this.gutterWidth + this.LINE_INSETS.left + change.end.col * this.charWidth;
                ctx.lineTo(x, y);
                // Line 6
                y = change.end.row * this.lineHeight;
                ctx.lineTo(x, y);
                // Line 7
                x = this.gutterWidth + this.LINE_INSETS.left + 180 * this.charWidth;
                ctx.lineTo(x, y);
                // Line 8
                y = change.start.row * this.lineHeight;
                ctx.lineTo(x, y);
                ctx.stroke();
            }.bind(this));
        }

        // scroll bars - x axis
        ctx.restore();

        // scrollbars - y axis
        ctx.restore();

        // paint scroll bars unless we don't need to :-)
        if (!refreshCanvas) {
            return;
        }

        // temporary disable of scrollbars
        // if (this.xscrollbar.rect) {
        //     return;
        // }

        if (this.horizontalScrollCanvas.width != cwidth) {
            this.horizontalScrollCanvas.width = cwidth;
        }

        if (this.horizontalScrollCanvas.height != this.NIB_WIDTH + 4) {
            this.horizontalScrollCanvas.height = this.NIB_WIDTH + 4;
        }

        if (this.verticalScrollCanvas.height != cheight) {
            this.verticalScrollCanvas.height = cheight;
        }

        if (this.verticalScrollCanvas.width != this.NIB_WIDTH + 4) {
            this.verticalScrollCanvas.width = this.NIB_WIDTH + 4;
        }

        var hctx = this.horizontalScrollCanvas.getContext("2d");
        hctx.clearRect(0, 0, this.horizontalScrollCanvas.width, this.horizontalScrollCanvas.height);
        hctx.save();

        var vctx = this.verticalScrollCanvas.getContext("2d");
        vctx.clearRect(0, 0, this.verticalScrollCanvas.width, this.verticalScrollCanvas.height);
        vctx.save();

        var ythemes = (this.overYScrollBar) || (this.yscrollbar.mousedownValue != null) ?
                      { n: ed.theme.fullNibStyle, a: ed.theme.fullNibArrowStyle, s: ed.theme.fullNibStrokeStyle } :
                      { n: ed.theme.partialNibStyle, a: ed.theme.partialNibArrowStyle, s: ed.theme.partialNibStrokeStyle };
        var xthemes = (this.overXScrollBar) || (this.xscrollbar.mousedownValue != null) ?
                      { n: ed.theme.fullNibStyle, a: ed.theme.fullNibArrowStyle, s: ed.theme.fullNibStrokeStyle } :
                      { n: ed.theme.partialNibStyle, a: ed.theme.partialNibArrowStyle, s: ed.theme.partialNibStrokeStyle };

        var midpoint = Math.floor(this.NIB_WIDTH / 2);


        var nibup = new Rect(cwidth - this.NIB_INSETS.right - this.NIB_WIDTH,
                this.NIB_INSETS.top, this.NIB_WIDTH, this.NIB_WIDTH);
        this.nibup = nibup;

        var nibdown = new Rect(cwidth - this.NIB_INSETS.right - this.NIB_WIDTH,
                cheight - (this.NIB_WIDTH * 2) - (this.NIB_INSETS.bottom * 2),
                this.NIB_INSETS.top,
                this.NIB_WIDTH, this.NIB_WIDTH);

        this.nibdown = nibdown;

        var nibleft = new Rect(this.gutterWidth + this.NIB_INSETS.left,
                cheight - this.NIB_INSETS.bottom - this.NIB_WIDTH,
                this.NIB_WIDTH,
                this.NIB_WIDTH);
        this.nibleft = nibleft;

        var nibright = new Rect(cwidth - (this.NIB_INSETS.right * 2) - (this.NIB_WIDTH * 2),
                cheight - this.NIB_INSETS.bottom - this.NIB_WIDTH,
                this.NIB_WIDTH,
                this.NIB_WIDTH);
        this.nibright = nibright;

        vctx.translate(-verticalx, 0);
        hctx.translate(0, -horizontaly);

        if (xscroll && ((this.overXScrollBar) || (this.xscrollbar.mousedownValue != null))) {
            hctx.save();

            hctx.beginPath();
            hctx.rect(this.nibleft.x + midpoint + 2, 0, this.nibright.x - this.nibleft.x - 1, cheight); // y points don't matter
            hctx.closePath();
            hctx.clip();

            hctx.fillStyle = ed.theme.scrollTrackFillStyle;
            hctx.fillRect(this.nibleft.x, this.nibleft.y - 1, this.nibright.x2 - this.nibleft.x, this.nibleft.h + 1);

            hctx.strokeStyle = ed.theme.scrollTrackStrokeStyle;
            hctx.strokeRect(this.nibleft.x, this.nibleft.y - 1, this.nibright.x2 - this.nibleft.x, this.nibleft.h + 1);

            hctx.restore();
        }

        if (yscroll && ((this.overYScrollBar) || (this.yscrollbar.mousedownValue != null))) {
            vctx.save();

            vctx.beginPath();
            vctx.rect(0, this.nibup.y + midpoint + 2, cwidth, this.nibdown.y - this.nibup.y - 1); // x points don't matter
            vctx.closePath();
            vctx.clip();

            vctx.fillStyle = ed.theme.scrollTrackFillStyle;
            vctx.fillRect(this.nibup.x - 1, this.nibup.y, this.nibup.w + 1, this.nibdown.y2 - this.nibup.y);

            vctx.strokeStyle = ed.theme.scrollTrackStrokeStyle;
            vctx.strokeRect(this.nibup.x - 1, this.nibup.y, this.nibup.w + 1, this.nibdown.y2 - this.nibup.y);

            vctx.restore();
        }

        if (yscroll) {
            // up arrow
            if ((showUpScrollNib) || (this.overYScrollBar) || (this.yscrollbar.mousedownValue != null)) {
                vctx.save();
                vctx.translate(this.nibup.x + midpoint, this.nibup.y + midpoint);
                this.paintNib(vctx, ythemes.n, ythemes.a, ythemes.s);
                vctx.restore();
            }

            // down arrow
            if ((showDownScrollNib) || (this.overYScrollBar) || (this.yscrollbar.mousedownValue != null)) {
                vctx.save();
                vctx.translate(this.nibdown.x + midpoint, this.nibdown.y + midpoint);
                vctx.rotate(Math.PI);
                this.paintNib(vctx, ythemes.n, ythemes.a, ythemes.s);
                vctx.restore();
            }
        }

        if (xscroll) {
            // left arrow
            if ((showLeftScrollNib) || (this.overXScrollBar) || (this.xscrollbar.mousedownValue != null)) {
                hctx.save();
                hctx.translate(this.nibleft.x + midpoint, this.nibleft.y + midpoint);
                hctx.rotate(Math.PI * 1.5);
                this.paintNib(hctx, xthemes.n, xthemes.a, xthemes.s);
                hctx.restore();
            }

            // right arrow
            if ((showRightScrollNib) || (this.overXScrollBar) || (this.xscrollbar.mousedownValue != null)) {
                hctx.save();
                hctx.translate(this.nibright.x + midpoint, this.nibright.y + midpoint);
                hctx.rotate(Math.PI * 0.5);
                this.paintNib(hctx, xthemes.n, xthemes.a, xthemes.s);
                hctx.restore();
            }
        }

        // the bar
        var sx = this.nibleft.x2 + 4;
        sw = this.nibright.x - this.nibleft.x2 - 9;
        this.xscrollbar.rect = new Rect(sx, this.nibleft.y - 1, sw, this.nibleft.h + 1);
        this.xscrollbar.value = -this.xoffset;
        this.xscrollbar.min = 0;
        this.xscrollbar.max = virtualwidth - (cwidth - this.gutterWidth);
        this.xscrollbar.extent = cwidth - this.gutterWidth;

        if (xscroll) {
            var fullonxbar = ((this.overXScrollBar && virtualwidth > cwidth) ||
                    (this.xscrollbar && this.xscrollbar.mousedownValue != null));

            if (!fullonxbar) {
                hctx.globalAlpha = 0.3;
            }
            this.paintScrollbar(hctx, this.xscrollbar);
            hctx.globalAlpha = 1.0;
        }

        var sy = this.nibup.y2 + 4;
        var sh = this.nibdown.y - this.nibup.y2 - 9;
        this.yscrollbar.rect = new Rect(this.nibup.x - 1, sy, this.nibup.w + 1, sh);
        this.yscrollbar.value = -this.yoffset;
        this.yscrollbar.min = 0;
        this.yscrollbar.max = virtualheight - (cheight - this.BOTTOM_SCROLL_AFFORDANCE);
        this.yscrollbar.extent = cheight;

        if (yscroll) {
            var fullonybar = (this.overYScrollBar && virtualheight > cheight) ||
                (this.yscrollbar && this.yscrollbar.mousedownValue != null);

            if (!fullonybar) {
                vctx.globalAlpha = 0.3;
            }
            this.paintScrollbar(vctx, this.yscrollbar);
            vctx.globalAlpha = 1;
        }

        // composite the scrollbars
        ctx.drawImage(this.verticalScrollCanvas, verticalx, 0);
        ctx.drawImage(this.horizontalScrollCanvas, 0, horizontaly);
        hctx.restore();
        vctx.restore();

        // clear the unusued nibs
        if (!showUpScrollNib) { this.nibup = new Rect(); }
        if (!showDownScrollNib) { this.nibdown = new Rect(); }
        if (!showLeftScrollNib) { this.nibleft = new Rect(); }
        if (!showRightScrollNib) { this.nibright = new Rect(); }

        //set whether scrollbars are visible, so mouseover and such can pass through if not.
        this.xscrollbarVisible = xscroll;
        this.yscrollbarVisible = yscroll;
    },

    paintScrollbar: function(ctx, scrollbar) {
        var bar = scrollbar.getHandleBounds();
        var alpha = (ctx.globalAlpha) ? ctx.globalAlpha : 1;

        if (!scrollbar.isH()) {
            ctx.save();     // restored in another if (!scrollbar.isH()) block at end of function
            ctx.translate(bar.x + Math.floor(bar.w / 2), bar.y + Math.floor(bar.h / 2));
            ctx.rotate(Math.PI * 1.5);
            ctx.translate(-(bar.x + Math.floor(bar.w / 2)), -(bar.y + Math.floor(bar.h / 2)));

            // if we're vertical, the bar needs to be re-worked a bit
            bar = new scroller.Rect(bar.x - Math.floor(bar.h / 2) + Math.floor(bar.w / 2),
                    bar.y + Math.floor(bar.h / 2) - Math.floor(bar.w / 2), bar.h, bar.w);
        }

        var halfheight = bar.h / 2;

        ctx.beginPath();
        ctx.arc(bar.x + halfheight, bar.y + halfheight, halfheight, Math.PI / 2, 3 * (Math.PI / 2), false);
        ctx.arc(bar.x2 - halfheight, bar.y + halfheight, halfheight, 3 * (Math.PI / 2), Math.PI / 2, false);
        ctx.lineTo(bar.x + halfheight, bar.y + bar.h);
        ctx.closePath();

        var gradient = ctx.createLinearGradient(bar.x, bar.y, bar.x, bar.y + bar.h);
        gradient.addColorStop(0, this.editor.theme.scrollBarFillGradientTopStart.replace(/%a/, alpha));
        gradient.addColorStop(0.4, this.editor.theme.scrollBarFillGradientTopStop.replace(/%a/, alpha));
        gradient.addColorStop(0.41, this.editor.theme.scrollBarFillStyle.replace(/%a/, alpha));
        gradient.addColorStop(0.8, this.editor.theme.scrollBarFillGradientBottomStart.replace(/%a/, alpha));
        gradient.addColorStop(1, this.editor.theme.scrollBarFillGradientBottomStop.replace(/%a/, alpha));
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.save();
        ctx.clip();

        ctx.fillStyle = this.editor.theme.scrollBarFillStyle.replace(/%a/, alpha);
        ctx.beginPath();
        ctx.moveTo(bar.x + (halfheight * 0.4), bar.y + (halfheight * 0.6));
        ctx.lineTo(bar.x + (halfheight * 0.9), bar.y + (bar.h * 0.4));
        ctx.lineTo(bar.x, bar.y + (bar.h * 0.4));
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(bar.x + bar.w - (halfheight * 0.4), bar.y + (halfheight * 0.6));
        ctx.lineTo(bar.x + bar.w - (halfheight * 0.9), bar.y + (bar.h * 0.4));
        ctx.lineTo(bar.x + bar.w, bar.y + (bar.h * 0.4));
        ctx.closePath();
        ctx.fill();

        ctx.restore();

        ctx.beginPath();
        ctx.arc(bar.x + halfheight, bar.y + halfheight, halfheight, Math.PI / 2, 3 * (Math.PI / 2), false);
        ctx.arc(bar.x2 - halfheight, bar.y + halfheight, halfheight, 3 * (Math.PI / 2), Math.PI / 2, false);
        ctx.lineTo(bar.x + halfheight, bar.y + bar.h);
        ctx.closePath();

        ctx.strokeStyle = this.editor.theme.scrollTrackStrokeStyle;
        ctx.stroke();

        if (!scrollbar.isH()) {
            ctx.restore();
        }
    },

    paintNib: function(ctx, nibStyle, arrowStyle, strokeStyle) {
        var midpoint = Math.floor(this.NIB_WIDTH / 2);

        ctx.fillStyle = nibStyle;
        ctx.beginPath();
        ctx.arc(0, 0, Math.floor(this.NIB_WIDTH / 2), 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = strokeStyle;
        ctx.stroke();

        ctx.fillStyle = arrowStyle;
        ctx.beginPath();
        ctx.moveTo(0, -midpoint + this.NIB_ARROW_INSETS.top);
        ctx.lineTo(-midpoint + this.NIB_ARROW_INSETS.left, midpoint - this.NIB_ARROW_INSETS.bottom);
        ctx.lineTo(midpoint - this.NIB_ARROW_INSETS.right, midpoint - this.NIB_ARROW_INSETS.bottom);
        ctx.closePath();
        ctx.fill();
    },

    /**
     * returns metadata about the string that represents the row;
     * converts tab characters to spaces
     */
    getRowString: function(row) {
        var content = this.get("content");
        return content.getRowMetadata(row).lineText;
    },

    getRowScreenLength: function(row) {
        return this.getRowString(row).length;
    },

    /**
     * returns the maximum number of display columns across all rows
     */
    getMaxCols: function(firstRow, lastRow) {
        var cols = 0;
        for (var i = firstRow; i <= lastRow; i++) {
            cols = Math.max(cols, this.getRowScreenLength(i));
        }
        return cols;
    },

    setSearchString: function(str) {
        var content = this.get("content");
        if (str && str != '') {
            this.searchString = str;
        } else {
            delete this.searchString;
        }

        content.searchStringChanged(this.searchString);

        this.editor.paint(true);
    },

    /**
     * This is a huge hack that experiments with marking changes
     */
    setChanges: function(changes) {
        this.changes = changes;
        console.log("changes=", this.changes);
    },

    dispose: function() {
    }
});

/**
 * A wrapper for the functionality that we are exposing to the clipboard
 * editor.
 */
var EditorWrapper = SC.Object.extend({
    /**
     * The things we are proxying to
     */
    editor: null,
    ui: null,

    /**
     * Proxy to the UI's setFocus()
     */
    focus: function() {
        this.ui.setFocus();
    },

    /**
     * Proxy to the UI's definition of if it has focus
     */
    hasFocus: function() {
        return this.ui.hasFocus();
    },

    /**
     * We need to add cut and paste handlers to something this provides an
     * element.
     */
    getFocusElement: function() {
        return this.ui._getFocusElement();
    },

    /**
     * i.e. cut, except that we don't affect the clipboard
     */
    removeSelection: function() {
        var selectionObject = this.editor.getSelection();
        var text = null;

        if (selectionObject) {
            var text = this.editor.model.getChunk(selectionObject);

            if (text && text != '') {
                this.ui.actions.beginEdit('cut');
                this.ui.actions.deleteSelection(selectionObject);
                this.ui.actions.endEdit();
            }
        }

        return text;
    },

    /**
     * Return the current selection
     * i.e. copy, except that we don't affect the clipboard
     */
    getSelection: function() {
        return this.editor.getSelectionAsText();
    },

    /**
     * Replace the current selection, or insert at the cursor
     * i.e. paste, except that the contents does not come from the clipboard
     */
    replaceSelection: function(text) {
        var args = cursor.buildArgs();
        args.chunk = text;
        if (args.chunk) {
            this.ui.actions.beginEdit('paste');
            this.ui.actions.insertChunk(args);
            this.ui.actions.endEdit();
        }
    },

    /**
     * Turn on the key combinations to access the clipboard.manual class
     * which basically only works with the editor only. Not in favour.
     * TODO: Really this should be an implementation like DOMEvents and
     * HiddenWorld.
     */
    installEditorOnly: function() {
        this.editor.bindKey("copySelection", "CMD C");
        this.editor.bindKey("pasteFromClipboard", "CMD V");
        this.editor.bindKey("cutSelection", "CMD X");
    }
});