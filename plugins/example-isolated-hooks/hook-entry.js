() => ({
  adjust(payload) {
    return { ...payload, ratio: Number(payload.ratio || 1) * 0.9 };
  },
  addHeader(payload) {
    return { statusCode: payload.statusCode, headers: { 'X-Plugin-example-isolated-hooks-Trace': 'sandboxed' } };
  },
})
