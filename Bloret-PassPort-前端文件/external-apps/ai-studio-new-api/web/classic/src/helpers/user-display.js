export function getUserDisplayName(user, fallback = 'User') {
  return user?.display_name || user?.nickname || user?.username || fallback;
}
