import type { ExtensionMessage, ExtensionResponse } from './types';



const RETRY_DELAYS_MS = [0, 500, 1000, 2000];

/** Options/admin calls can wait; compose/comprehend stay near the §5.4 wall clock. */
const MESSAGE_TIMEOUT_MS = 90_000;
const COMPOSE_MESSAGE_TIMEOUT_MS = 12_000;



function sleep(ms: number): Promise<void> {

  return new Promise((resolve) => setTimeout(resolve, ms));

}



function isTransientMessagingError(error: unknown): boolean {

  const message = error instanceof Error ? error.message : String(error);

  return (

    message.includes('Receiving end does not exist') ||

    message.includes('Could not establish connection') ||

    message.includes('Background returned no response')

  );

}



function formatMessagingError(error: unknown): string {

  const message = error instanceof Error ? error.message : String(error);



  if (message.includes('Extension context invalidated')) {

    return 'Extension was reloaded. Close this tab, reopen Options from chrome://extensions, and try again.';

  }

  if (

    message.includes('Receiving end does not exist') ||

    message.includes('Could not establish connection')

  ) {

    return (

      'Background service worker is inactive. On chrome://extensions, click the "service worker" link ' +

      'under X Reply Copilot to wake it, then try again — or reload the extension.'

    );

  }

  if (message.includes('timed out') || message.includes('Timeout')) {

    return 'Request timed out. Check your network connection and try again.';

  }



  return message || 'Could not reach the extension background. Reload the extension and try again.';

}



/** Best-effort ping to wake an MV3 service worker before a real message. */

async function wakeServiceWorker(): Promise<void> {

  try {

    await chrome.runtime.sendMessage({ type: 'PING' });

  } catch {

    /* SW may still be starting — caller will retry */

  }

}



/** Send a message to the background service worker, waking it and retrying on transient MV3 failures. */

export async function sendExtensionMessage(msg: ExtensionMessage): Promise<ExtensionResponse> {

  let lastError: unknown;



  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {

    if (RETRY_DELAYS_MS[attempt]! > 0) {

      await sleep(RETRY_DELAYS_MS[attempt]!);

    }



    await wakeServiceWorker();



    try {

      const timeoutMs =
        msg.type === 'COMPOSE' || msg.type === 'COMPREHEND'
          ? COMPOSE_MESSAGE_TIMEOUT_MS
          : MESSAGE_TIMEOUT_MS;

      const response = await Promise.race([

        chrome.runtime.sendMessage(msg) as Promise<ExtensionResponse | undefined>,

        new Promise<never>((_, reject) => {

          setTimeout(() => reject(new Error('Message timed out')), timeoutMs);

        }),

      ]);



      if (!response) {

        throw new Error('Background returned no response');

      }



      return response;

    } catch (error) {

      lastError = error;

      // Non-transient errors (timeouts, invalid message, SW bugs) must not fan out
      // across all four attempts × MESSAGE_TIMEOUT_MS — that multiplied an 8s compose
      // into minutes. Only wake/connection races are retryable.
      if (!isTransientMessagingError(error)) {

        break;

      }

    }

  }



  throw new Error(formatMessagingError(lastError));

}

