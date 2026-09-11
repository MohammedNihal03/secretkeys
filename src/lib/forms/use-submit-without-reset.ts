'use client';

import { useTransition, type FormEvent } from 'react';

/**
 * Submits a form through a `useActionState` dispatcher without React's
 * automatic form reset.
 *
 * React 19 resets a `<form action>` once its action runs. Text inputs recover
 * from that, but a `<select>` falls back to whichever option was selected when
 * the form first mounted -- not the value React last rendered. So after any
 * validation error a select can quietly show, and then submit, a different
 * option from the one the user chose. In testing, an Azure OpenAI key form
 * switched itself to Anthropic after an endpoint error, and the key was saved
 * against Anthropic.
 *
 * Calling `preventDefault` and dispatching inside a transition runs the same
 * action with the same pending state, but React skips the reset. Keep
 * `action={dispatch}` on the form as well, so it still submits without
 * JavaScript.
 */
export function useSubmitWithoutReset(dispatch: (payload: FormData) => void) {
  const [, startTransition] = useTransition();

  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  };
}
