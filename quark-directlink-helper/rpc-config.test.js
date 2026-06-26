const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;
const contentSource = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

function loadContentExports() {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    location: { hostname: 'example.com' },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(contentSource, sandbox, { filename: 'content.js' });
  return sandbox.module.exports;
}

const rpcHelpers = loadContentExports();

function assertPlainDeepEqual(actual, expected, message) {
  // vm.runInNewContext 返回的对象原型属于沙箱上下文；转成普通 JSON 后再做行为断言。
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}

assert.strictEqual(
  typeof rpcHelpers.getRpcConfigPromptDefaults,
  'function',
  'content.js should export getRpcConfigPromptDefaults for local RPC config checks'
);
assert.strictEqual(
  typeof rpcHelpers.resolveRpcConfigPromptResult,
  'function',
  'content.js should export resolveRpcConfigPromptResult for local RPC config checks'
);

assertPlainDeepEqual(
  rpcHelpers.getRpcConfigPromptDefaults({
    rpcUrl: 'http://localhost:29100/jsonrpc',
    rpcSecret: 'Qwcvbwkb6A0hfS1S',
  }),
  {
    rpcUrl: 'http://localhost:29100/jsonrpc',
    secret: 'Qwcvbwkb6A0hfS1S',
  },
  'RPC config prompt should prefill both saved URL and saved Secret'
);

assertPlainDeepEqual(
  rpcHelpers.resolveRpcConfigPromptResult({
    currentUrl: 'http://localhost:29100/jsonrpc',
    currentSecret: 'Qwcvbwkb6A0hfS1S',
    promptedUrl: null,
    promptedSecret: 'should-not-save',
  }),
  {
    shouldSave: false,
    canceled: true,
    rpcUrl: 'http://localhost:29100/jsonrpc',
    secret: 'Qwcvbwkb6A0hfS1S',
  },
  'Canceling the URL prompt must keep the saved URL/Secret and skip saving'
);

assertPlainDeepEqual(
  rpcHelpers.resolveRpcConfigPromptResult({
    currentUrl: 'http://localhost:29100/jsonrpc',
    currentSecret: 'Qwcvbwkb6A0hfS1S',
    promptedUrl: 'http://127.0.0.1:29100/jsonrpc',
    promptedSecret: null,
  }),
  {
    shouldSave: false,
    canceled: true,
    rpcUrl: 'http://localhost:29100/jsonrpc',
    secret: 'Qwcvbwkb6A0hfS1S',
  },
  'Canceling the Secret prompt must keep the saved URL/Secret and skip saving'
);

assertPlainDeepEqual(
  rpcHelpers.resolveRpcConfigPromptResult({
    currentUrl: 'http://localhost:29100/jsonrpc',
    currentSecret: 'Qwcvbwkb6A0hfS1S',
    promptedUrl: ' http://127.0.0.1:29100/jsonrpc ',
    promptedSecret: '',
  }),
  {
    shouldSave: true,
    canceled: false,
    rpcUrl: 'http://127.0.0.1:29100/jsonrpc',
    secret: '',
  },
  'Confirming an empty Secret should save and clear the previous Secret'
);

assert(
  /rpcSecret\s*:\s*rpc\.secret/.test(backgroundSource),
  'GL_QUARK_GET_ACCOUNTS should return saved rpcSecret so the config prompt can prefill it'
);

console.log('RPC config prompt checks passed');
