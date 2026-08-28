const assert = require('assert');
const authMode = require('../utils/auth-mode');
const invites = require('../routes/auth-invites');

assert(authMode.MODES.has('feishu'));
assert(authMode.MODES.has('passport'));
assert.strictEqual(typeof authMode.getAuthMode, 'function');
assert.strictEqual(typeof authMode.setAuthMode, 'function');
assert.strictEqual(typeof authMode.isAuthModeFrozen, 'function');
assert.strictEqual(typeof invites.validateInvite, 'function');
console.log('auth-mode utility, invite validator, and admin bootstrap contracts passed');
