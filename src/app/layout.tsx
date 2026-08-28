import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'EduCBT',
  description: 'School examination and academic records',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
