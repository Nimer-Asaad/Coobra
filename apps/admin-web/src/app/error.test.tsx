// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import PageError from './error';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

describe('PageError (API outage)', () => {
  it('explains the outage and retries the server render', async () => {
    const reset = vi.fn();
    renderWithProviders(<PageError error={new Error('fetch failed')} reset={reset} />);
    expect(screen.getByText('This page could not load')).toBeTruthy();
    expect(
      screen.getByText('COOBRA is temporarily unavailable. Try again in a moment.'),
    ).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });

  it('renders in Arabic', () => {
    renderWithProviders(<PageError error={new Error('fetch failed')} reset={vi.fn()} />, 'ar');
    expect(screen.getByText('تعذّر تحميل هذه الصفحة')).toBeTruthy();
    expect(screen.getByText('خدمة كوبرا غير متاحة مؤقتاً. حاول مرة أخرى بعد قليل.')).toBeTruthy();
  });
});
