export function bindRequestAbort(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted && !res.writableEnded) controller.abort();
  };
  req.once("aborted", abort);
  res.once("close", abort);
  return {
    signal: controller.signal,
    dispose() {
      req.off("aborted", abort);
      res.off("close", abort);
    },
  };
}
