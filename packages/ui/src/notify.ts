import type { Message } from '@symposium/engine/protocol';

const NOTIFY_KEY = 'symposium.notify';

/** What a desktop notification says. */
export interface Notice {
  title: string;
  body: string;
}

/** Whether a message is a card that waits for the human: a plan, a hire, a command or a change. */
export function waitsForYou(message: Message): boolean {
  const meta = message.meta;
  return meta !== null && meta.type !== 'notice' && meta.status === 'pending';
}

export function waitingCount(messages: Message[]): number {
  return messages.filter(waitsForYou).length;
}

/** The tab's title, with the number of things that wait for the human in front. */
export function pageTitle(waiting: number): string {
  return waiting > 0 ? `(${waiting}) Symposium` : 'Symposium';
}

/**
 * What to say when a card arrives that holds an agent up until the human decides: a plan, a
 * command or a hire. A change holds nobody up, so it is told when the team stops.
 */
export function arrivalNotice(
  message: Message,
  groupName: string,
  nameOf: (agentId: string) => string,
): Notice | undefined {
  const meta = message.meta;
  if (!meta || !waitsForYou(message)) return undefined;
  switch (meta.type) {
    case 'plan':
      return {
        title: `${groupName}: a plan waits for your approval`,
        body: `${nameOf(meta.leadId)} wants to hand out work. Nobody starts before you approve.`,
      };
    case 'command':
      return {
        title: `${groupName}: ${nameOf(meta.agentId)} asks to run a command`,
        body: meta.command,
      };
    case 'hire-proposal':
      return {
        title: `${groupName}: a hire waits for your approval`,
        body: `${nameOf(meta.proposedBy)} proposes to hire ${meta.hire.name}.`,
      };
    default:
      return undefined;
  }
}

/**
 * What to say when the whole team has stopped working. Nothing when a plan, a command or a hire
 * is why it stopped: that card was announced when it arrived.
 */
export function stoppedNotice(messages: Message[], groupName: string): Notice | undefined {
  const waiting = messages.filter(waitsForYou);
  const changes = waiting.filter((message) => message.meta?.type === 'diff').length;
  if (waiting.length > changes) return undefined;
  return {
    title: `${groupName}: the team has stopped working`,
    body:
      changes === 0
        ? 'Nothing waits for your approval.'
        : `${changes} ${changes === 1 ? 'change waits' : 'changes wait'} for your merge.`,
  };
}

/** `unsupported`: this browser has no notifications. `blocked`: the human said no to them. */
export type NotifyState = 'on' | 'off' | 'blocked' | 'unsupported';

/** Whether notifications are wanted and the browser allows them. */
export function notifyState(): NotifyState {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const wanted = localStorage.getItem(NOTIFY_KEY) === 'on';
  return wanted && Notification.permission === 'granted' ? 'on' : 'off';
}

/**
 * Switches notifications on or off. Switching on asks the browser for its permission the first
 * time, which browsers only allow from a click.
 */
export async function toggleNotify(): Promise<NotifyState> {
  const state = notifyState();
  if (state === 'unsupported' || state === 'blocked') return state;
  if (state === 'on') {
    localStorage.setItem(NOTIFY_KEY, 'off');
    return 'off';
  }
  const permission =
    Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission === 'granted') localStorage.setItem(NOTIFY_KEY, 'on');
  return notifyState();
}

/**
 * Shows a notification, but only when the human is not looking at Symposium: with the page in
 * view the cards themselves say it. Clicking it brings the page to the front.
 */
export function notify(notice: Notice, tag: string): void {
  if (notifyState() !== 'on') return;
  if (!document.hidden && document.hasFocus()) return;
  try {
    const shown = new Notification(notice.title, { body: notice.body, tag });
    shown.onclick = () => {
      window.focus();
      shown.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker. Then there are none.
  }
}
