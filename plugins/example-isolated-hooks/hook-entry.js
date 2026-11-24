() => ({
  adjust(payload) {
    return { ...payload, ratio: Number(payload.ratio || 1) * 0.9 };
  },
  addHeader(payload) {
    return { statusCode: payload.statusCode, headers: { 'X-Plugin-example-isolated-hooks-Trace': 'sandboxed' } };
  },
  filterModels(payload) {
    return { models: payload.models.filter(model => !model.id.startsWith('internal-')) };
  },
  sortCandidates(payload) {
    return { candidateIds: payload.candidates.map(candidate => candidate.id).reverse() };
  },
})
