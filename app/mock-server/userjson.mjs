// Serializers for users (shared by the public and admin APIs).

export function avatarFor(user, origin) {
  return [300, 640].map((size) => ({ url: `${origin}/art/user/${encodeURIComponent(user.id)}.svg?s=${size}`, width: size, height: size }))
}

export function userJson(user, origin) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: avatarFor(user, origin),
    role: user.role ?? 'user'
  }
}
