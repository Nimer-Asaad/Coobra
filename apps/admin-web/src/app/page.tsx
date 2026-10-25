import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/api-server';
import { getChosenLanguage } from '@/lib/i18n-server';

export default async function Home() {
  if (!(await getChosenLanguage())) redirect('/choose-language');
  redirect((await getCurrentSession()) ? '/dashboard' : '/login');
}
