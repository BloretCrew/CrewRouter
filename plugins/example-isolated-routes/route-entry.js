() => ({
  echo(request) {
    return { status: 200, body: { ok: true, method: request.method, authRole: request.authRole, body: request.body } };
  },
})
