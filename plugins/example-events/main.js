async (ctx) => {
  ctx.events.on('model.health.changed.v1', async event => {
    ctx.log.info('model health event', event.payload.modelId, event.payload.health);
  });
  ctx.events.on('quota.threshold.v1', async event => {
    ctx.log.info('quota threshold event', event.payload.scope, event.payload.threshold);
  });
}
