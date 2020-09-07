import { sprintf } from "sprintf-js";
import { debuglog } from "util";
import * as blessed from "blessed";
import * as fs from "fs";

const PIN_LABELS = "ABCDEFGHI";

var screen;
var logger;
var debugLogger;
var inputLine;
var statusLine;
var txtActiveDevice;
var txtPublishTxs;
var pinBox;
var logFile = fs.createWriteStream("log.txt", {flags:'a'});
var debugFile = fs.createWriteStream("debug.txt", {flags:'a'});

var uiActions = {
    listDevices: null,
    getAddress: null,
    getMasterPubKey: null,
    togglePinProtection: null,
    togglePassphraseProtection: null,
    showFeatures: null,
    recoverDevice: null,
    backupDevice: null,
    changeLabel: null,
    signMessage: null,
    signTransaction: null,
    purchaseTicket: null,
    initDevice: null,
    togglePublishTxs: null,
    changeHomeScreen: null,
    validateAddress: null,
    importScript: null,

    switchLog: () => {
        debugLogger.toggle();
        logger.toggle();
        screen.render();
    },

    quit: () => {
        logFile.end();
        screen.destroy();
    },
};

export function queryInput(msg, initialValue) {
    inputLine.setLabel(msg);
    inputLine.clearValue();
    if (initialValue) {
        inputLine.setValue(initialValue);
    }
    inputLine.show();
    inputLine.focus();
    inputLine.enableInput();
    screen.render();

    const hider = () => {
        inputLine.hide();
        screen.render();
    };

    return new Promise((resolve, reject) => {
        let resolver, rejecter;
        resolver = () => {
            inputLine.unkey("escape", rejecter);
            hider();
            resolve(inputLine.getValue());
        };
        rejecter = () => {
            inputLine.unkey("enter", resolver);
            hider();
            reject("canceled");
        };
        inputLine.onceKey("enter", resolver);
        inputLine.onceKey("escape", rejecter)
    });
}

export function buildUI(actions) {
    screen = blessed.screen({
        // dump: "./log.txt",
        smartCSR: true,
        autoPadding: false,
        warnings: true,
        "cursor.shape": "block",
        "cursor.color": "#eeeeee",
    });
    screen.enableInput();

    logger = blessed.log({
        parent: screen,
        top: 'top',
        left: 0,
        label: "Output Log",
        right: 30,
        bottom: 4,
        border: 'line',
        tags: true,
        keys: true,
        vi: true,
        mouse: true,
        scrollback: 1000,
        scrollbar: {
            ch: ' ',
            track: {
                bg: 'yellow'
            },
            style: {
                inverse: true
            }
        }
    });

    debugLogger = blessed.log({
        parent: screen,
        top: 'top',
        left: 0,
        label: "Debug Log",
        right: 30,
        bottom: 4,
        border: 'line',
        tags: true,
        keys: true,
        vi: true,
        mouse: true,
        hidden: true,
        scrollback: 1000,
        scrollbar: {
            ch: ' ',
            track: {
                bg: 'yellow'
            },
            style: {
                inverse: true
            }
        }
    })

    const tryAction = name => async () => {
        try {
            const action = uiActions[name];
            if (action) {
                await action();
            }
        } catch (err) {
            if (err === "canceled") return;
            if (err instanceof Error) {
                log("Error:", err.message);
                debugLog(err.stack);
            } else {
                log("Exception: %s", err);
            }
        }
    };

    const actionList = blessed.list({
        parent: screen,
        right: 0,
        width: 30,
        bottom: 4,
        border: "line",
        label: "Actions",
        scrollable: true,
        mouse: true,
        scrollbar: {
            ch: ' ',
            track: {
                bg: 'yellow'
            },
            style: {
                inverse: true
            }
        }
    })

    const actionsDefns = [
        { label: "get address", keys: ['a'], callback: tryAction("getAddress") },
        { label: "switch log", keys: ["l"], callback: tryAction("switchLog") },
        { label: "list devices", keys: ["d"], callback: tryAction("listDevices") },
        { label: "get MasterPubKey", keys: ["m"], callback: tryAction("getMasterPubKey") },
        { label: "validate address on wallet", keys: ['v'], callback: tryAction("validateAddress") },
        { label: "toggle pin", keys: ["p"], callback: tryAction("togglePinProtection") },
        { label: "toggle passphrase", keys: ["k"], callback: tryAction("togglePassphraseProtection") },
        { label: "show features", keys: ["f"], callback: tryAction("showFeatures") },
        { label: "sign message", keys: ["s"], callback: tryAction("signMessage") },
        { label: "sign transaction", keys: ["t"], callback: tryAction("signTransaction") },
        { label: "backup device", keys: ["b"], callback: tryAction("backupDevice") },
        { label: "purchase ticket", keys: ["C-p"], callback: tryAction("purchaseTicket") },
        { label: "import wallet script", keys: ["C-u"], callback: tryAction("importScript") },
        { label: "wipe device", keys: ["C-w"], callback: tryAction("wipeDevice") },
        { label: "recover device", keys: ["C-r"], callback: tryAction("recoverDevice") },
        { label: "init device", keys: ["C-n"], callback: tryAction("initDevice") },
        { label: "change label", keys: ["C-l"], callback: tryAction("changeLabel") },
        { label: "change homescreen", keys: ["C-g"], callback: tryAction("changeHomeScreen") },
        { label: "toggle publish txs", keys: ["S-t"], callback: tryAction("togglePublishTxs") },
        { label: "quit", keys: ["q"], callback: tryAction("quit") },
    ];

    actionsDefns.forEach(a => {
        const label = sprintf("%3s: %s", a.keys[0], a.label);
        actionList.addItem(label);
        screen.key(a.keys[0], a.callback);
    });

    inputLine = blessed.textbox({
        label: 'Command',
        parent: screen,
        input: true,
        keys: true,
        mouse: true,
        bottom: 1,
        height: 3,
        border: "line",
        inputOnFocus: true,
        hidden: true,
    });

    statusLine = blessed.box({
        parent: screen,
        // content: "{#0fe1ab-fg}bla{/} BLe {#0fe1ab-fg}bli{/}",
        bg: "#073642",
        bottom: 0,
        height: 1,
    });

    txtActiveDevice = blessed.box({
        parent: statusLine,
        content: "",
        fg: "#eee8d5",
        left: 1,
        width: 20,
        bg: "#073642",
    });

    txtPublishTxs = blessed.box({
        parent: statusLine,
        content: "",
        fg: "#eee8d5",
        left: 25,
        width: 16,
        bg: "#073642",
    });

    pinBox = blessed.box({
        parent: screen,
        top: "center",
        left: "center",
        width: 20,
        height: 7,
        hidden: true,
        bg: "#073642",
        label: "Pin Entry",
        border: "line",
        shadow: true,
    });

    for (let i = 0; i < 9; i++) {
        const btn = blessed.button({
            parent: pinBox,
            left: 1 + 14 - Math.floor(i % 3) * 7,
            top: 1 + Math.floor(i / 3) * 2,
            height: 1,
            width: 4,
            label: PIN_LABELS[8-i],
            mouse: true,
        });
        btn.on("press", () => {
            inputLine.setValue(inputLine.getValue() + PIN_LABELS[8-i]);
            screen.render();
        });
    }

    const now = new Date();
    const nowFmt = now.toString();
    log("Starting up at %s", nowFmt);

    screen.on("destroy", () => process.exit());

    uiActions = Object.assign({}, uiActions, actions);
}

export function setActiveDeviceLabel(label) {
    txtActiveDevice.setText(label);
    screen.render();
}

export function setPublishTxsState(state) {
    txtPublishTxs.setText(state ? "PUBLISHING TXs" : "");
    screen.render();
}

export async function queryForPin() {
    pinBox.show();
    screen.render();
    try {
        let valid = false;
        let res = "";
        let query = "Enter PIN";
        while (!valid) {
            valid = true;
            const typed = await queryInput(query);
            res = typed.split("").map(v => {
                const idx = PIN_LABELS.indexOf(v);
                valid = valid && (idx > -1);
                return idx+1;
            }).join("");
            query = "Enter PIN (type only the supported chars)";
        }
        pinBox.hide();
        screen.render();
        return res;
    } catch (err) {
        pinBox.hide();
        screen.render();
        throw err;
    }
}

export function runUI() {
    screen.render();
}

function logTo(dstLogger, format, ...args) {
    if (typeof format !== "string") {
        args = args || [];
        args.unshift(format);
        format = "%s";
    }

    if (format.length > 1000) {
        format = format.substring(0, 1000);
    }

    format = '{#0fe1ab-fg}%s{/} ' + format;
    const now = new Date();
    const nowFmt = sprintf("%02d:%02d:%02d", now.getHours(),
        now.getMinutes(), now.getSeconds());

    args = (args.map(f => {
        if (typeof f === `string`) {
            if (f.length > 1000) {
                return `${f.substring(0, 1000)}...`;
            }
        } else if (f instanceof Error) {
            return f.stack;
        } else if (typeof f === `object`) {
            let asStr = JSON.stringify(f);
            if (asStr.lenth > 1000) {
                asStr = asStr.substring(0, 1000);
            }
            return asStr;
        }
        return f;
    }));
    // console.log("xxxxx args", args);

    args.unshift(nowFmt);
    dstLogger.log(format, ...args);
    screen.render();
}

export function log(format, ...args) {
    if (typeof format !== "string") {
        args = args || [];
        args.unshift(format);
        format = "%s";
    }

    logTo(logger, format, ...args);
    logFile.write(sprintf(format, ...args));
    logFile.write("\n");
}

export function debugLog(format, ...args) {
    logTo(debugLogger, format, ...args);
    debugFile.write(sprintf(format, ...args));
    debugFile.write("\n");
}
