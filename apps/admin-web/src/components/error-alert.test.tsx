// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ErrorCode } from '@coobra/shared';
import { ClientApiError } from '@/lib/api-client';
import { renderWithProviders } from '@/test/render';
import { ErrorAlert } from './error-alert';

const error = (code: ErrorCode, statusCode = 400) =>
  new ClientApiError({ statusCode, code, message: 'developer text' });

describe('ErrorAlert', () => {
  it.each([
    ['en', 'SERVICE_UNAVAILABLE', 'COOBRA is temporarily unavailable. Try again in a moment.'],
    ['ar', 'SERVICE_UNAVAILABLE', 'خدمة كوبرا غير متاحة مؤقتاً. حاول مرة أخرى بعد قليل.'],
    ['en', 'FORBIDDEN', "You don't have permission to do that."],
    ['ar', 'FORBIDDEN', 'ليست لديك صلاحية للقيام بذلك.'],
    [
      'ar',
      'SELF_APPROVAL_FORBIDDEN',
      'لا يمكنك اعتماد شيء أنشأته أو اقترحته بنفسك. اطلب ذلك من زميل.',
    ],
  ] as const)('translates %s %s instead of showing the developer message', (lang, code, text) => {
    renderWithProviders(<ErrorAlert error={error(code)} />, lang);
    expect(screen.getByRole('alert').textContent).toBe(text);
    expect(screen.queryByText('developer text')).toBeNull();
  });

  it('renders nothing without an error', () => {
    const { container } = renderWithProviders(<ErrorAlert error={null} />);
    expect(container.textContent).toBe('');
  });
});
