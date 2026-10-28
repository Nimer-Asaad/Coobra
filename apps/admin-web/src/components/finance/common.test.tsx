// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { ApiErrorBody } from '@coobra/shared';
import { FormField } from '@/components/form-field';
import { ClientApiError } from '@/lib/api-client';
import { renderWithProviders } from '@/test/render';
import { InlineAction, useFieldError } from './common';

const apiError = (body: Partial<ApiErrorBody>) =>
  new ClientApiError({ statusCode: 400, code: 'VALIDATION_FAILED', message: 'x', ...body });

/** A fee-correction-like form whose server rejects short reasons and then a forbidden user. */
function FeeForm({ reject }: { reject: 'field' | 'forbidden' | 'none' }) {
  const [error, setError] = useState<unknown>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const fieldError = useFieldError(error);
  return (
    <>
      <InlineAction
        label="Correct the fee"
        successMessage="Correction sent."
        pending={false}
        error={error}
        onSubmit={async (form) => {
          const failure =
            reject === 'field'
              ? apiError({ fieldErrors: { reason: 'validation.reason.required' } })
              : reject === 'forbidden'
                ? apiError({ statusCode: 403, code: 'FORBIDDEN' })
                : null;
          setError(failure);
          if (failure) throw failure;
          setSubmitted(String(form.get('fee')));
        }}
      >
        <FormField name="fee" inputMode="decimal" defaultValue="15.00" label="Fee" />
        <FormField name="reason" label="Reason" />
        {fieldError('reason')}
      </InlineAction>
      {submitted ? <p data-testid="submitted">{submitted}</p> : null}
    </>
  );
}

const confirmButton = () => screen.getByRole('button', { name: 'Confirm' });

describe('InlineAction', () => {
  it('hides a field error from the last attempt as soon as the form is edited', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeeForm reject="field" />);
    await user.click(screen.getByRole('button', { name: 'Correct the fee' }));
    await user.click(confirmButton());
    expect(screen.getByText('Please write a reason (at least 3 characters).')).toBeTruthy();
    await user.type(screen.getByLabelText('Reason'), 'Wrong zone');
    expect(screen.queryByText('Please write a reason (at least 3 characters).')).toBeNull();
  });

  it('hides a request error once the form changes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeeForm reject="forbidden" />);
    await user.click(screen.getByRole('button', { name: 'Correct the fee' }));
    await user.click(confirmButton());
    expect(screen.getByText("You don't have permission to do that.")).toBeTruthy();
    await user.type(screen.getByLabelText('Reason'), 'x');
    expect(screen.queryByText("You don't have permission to do that.")).toBeNull();
  });

  it('replaces a prefilled amount instead of appending to it, then confirms success', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeeForm reject="none" />);
    await user.click(screen.getByRole('button', { name: 'Correct the fee' }));
    await user.click(screen.getByLabelText('Fee'));
    await user.keyboard('16');
    expect((screen.getByLabelText('Fee') as HTMLInputElement).value).toBe('16');
    await user.click(confirmButton());
    expect(screen.getByTestId('submitted').textContent).toBe('16');
    expect(within(screen.getByRole('status')).getByText('Correction sent.')).toBeTruthy();
    // The form closed; reopening clears the confirmation.
    await user.click(screen.getByRole('button', { name: 'Correct the fee' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
