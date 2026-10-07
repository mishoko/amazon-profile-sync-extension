// A minimal state container. State changes only through `dispatch`, which runs
// a pure reducer; subscribers re-render from the new state. Side effects
// (storage, network) live outside the reducer and dispatch their results.
export function createStore(reducer, initialState) {
  let state = initialState;
  const listeners = new Set();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
