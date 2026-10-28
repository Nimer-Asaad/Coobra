import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api-client';
import { ApiContext } from '../api-context';
import { renderMobile } from '../test/render';
import { ForgotPasswordScreen } from './forgot-password-screen';

describe('ForgotPasswordScreen', () => {
  it('submits with the Enter key', async () => {
    const request = vi.fn(async () => undefined);
    renderMobile(
      <ApiContext.Provider value={{ request } as unknown as ApiClient}>
        <ForgotPasswordScreen />
      </ApiContext.Provider>,
    );
    const email = screen.getByLabelText('Email');
    fireEvent.change(email, { target: { value: 'driver@example.com' } });
    fireEvent.keyDown(email, { key: 'Enter' });
    expect(
      await screen.findByText(
        'If an account exists for this email, a reset link is on its way. Check your inbox.',
      ),
    ).toBeTruthy();
    expect(request).toHaveBeenCalledWith('/v1/auth/forgot-password', {
      method: 'POST',
      body: { email: 'driver@example.com' },
    });
  });
});
