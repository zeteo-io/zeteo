// Set when the background renewal finds the session over. AuthProvider then
// shows a notice over the page instead of leaving it, and the API client
// neither sends requests nor starts a sign-in of its own.
let ended = false;

export const sessionEnded = (): boolean => ended;

export const setSessionEnded = (value: boolean): void => {
  ended = value;
};
