() => ({
  adjust(payload) {
    return { ...payload, ratio: Number(payload.ratio || 1) * 0.9 };
  },
})
