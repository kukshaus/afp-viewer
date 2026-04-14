import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'AFP Viewer',
  description:
    'High-performance browser-based viewer for IBM AFP (Advanced Function Presentation) documents. Supports text, images, graphics, barcodes, and fonts.',
  keywords: ['AFP', 'viewer', 'IBM', 'Advanced Function Presentation', 'MO:DCA', 'PTOCA', 'IOCA'],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  );
}
