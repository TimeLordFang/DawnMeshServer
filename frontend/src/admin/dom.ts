import { element } from '../shared/dom';
interface Elements {
  "#login-view": HTMLElement;
  "#login-form": HTMLFormElement;
  "#token-input": HTMLInputElement;
  "#toggle-token": HTMLButtonElement;
  "#login-button": HTMLButtonElement;
  "#login-error": HTMLElement;
  "#dashboard-view": HTMLElement;
  "#instance-name": HTMLElement;
  "#connection-state": HTMLElement;
  "#refresh-button": HTMLButtonElement;
  "#logout-button": HTMLButtonElement;
  "#stats": HTMLElement;
  "#last-updated": HTMLElement;
  "#notice": HTMLElement;
  "#listening-panel": HTMLElement;
  "#listening-title": HTMLElement;
  "#listening-status": HTMLElement;
  "#monitor-audio": HTMLElement;
  "#resume-audio-button": HTMLButtonElement;
  "#stop-listening-button": HTMLButtonElement;
  "#rooms": HTMLElement;
}
export const $ = <K extends keyof Elements>(selector: K): Elements[K] => element<Elements[K]>(selector);
