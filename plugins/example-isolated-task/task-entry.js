() => ({
  sum(payload) {
    const values = Array.isArray(payload.values) ? payload.values : [];
    return { sum: values.reduce((total, value) => total + Number(value || 0), 0) };
  },
})
