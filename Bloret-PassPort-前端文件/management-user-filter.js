/**
 * Pure client/server-shared predicates for the admin user management list.
 * Used by generateManagementPageHtml (injected into page script) and unit tests.
 */

/**
 * @param {{ username?: string, email?: string, tags?: string, admin?: string|boolean, twoFa?: string|boolean, passkey?: string|boolean }} row
 * @param {{ keyword?: string, role?: string, twoFa?: string, passkey?: string }} filters
 *   role: '' | 'admin' | 'user'
 *   twoFa / passkey: '' | '1' | '0'
 * @returns {boolean}
 */
function matchManagementUserRow(row, filters = {}) {
    const keyword = String(filters.keyword || '').trim().toLowerCase();
    if (keyword) {
        const haystack = [
            row.username || '',
            row.email || '',
            row.tags || ''
        ].join(' ').toLowerCase();
        if (!haystack.includes(keyword)) return false;
    }

    const role = String(filters.role || '');
    if (role === 'admin' && !isTruthyFlag(row.admin)) return false;
    if (role === 'user' && isTruthyFlag(row.admin)) return false;

    const twoFa = String(filters.twoFa || '');
    if (twoFa === '1' && !isTruthyFlag(row.twoFa)) return false;
    if (twoFa === '0' && isTruthyFlag(row.twoFa)) return false;

    const passkey = String(filters.passkey || '');
    if (passkey === '1' && !isTruthyFlag(row.passkey)) return false;
    if (passkey === '0' && isTruthyFlag(row.passkey)) return false;

    return true;
}

function isTruthyFlag(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}

/**
 * Collect usernames from checkbox-like objects that are checked and visible.
 * @param {Array<{ value: string, checked: boolean, rowHidden?: boolean }>} items
 * @returns {string[]}
 */
function getSelectedUsernames(items) {
    return (items || [])
        .filter((item) => item && item.checked && !item.rowHidden)
        .map((item) => String(item.value));
}

module.exports = {
    matchManagementUserRow,
    getSelectedUsernames,
    isTruthyFlag
};
