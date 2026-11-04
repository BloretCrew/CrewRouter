function buildCommentAuthor(auth, normalizeUsernameKey) {
    const username = String(auth?.username || '').trim();
    const nickname = String(auth?.nickname || username).trim() || username;
    const usernameKey = normalizeUsernameKey(username);
    return { username, nickname, usernameKey };
}

module.exports = { buildCommentAuthor };