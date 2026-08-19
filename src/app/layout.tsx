import type { Metadata } from "next";
import { Epilogue, Hanken_Grotesk } from "next/font/google";

import { ThemeProvider } from "@/components/theme-provider";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/brand";
import "./globals.css";

/**
 * Two faces, and no others.
 *
 * Epilogue carries the display sizes and every time and duration; Hanken
 * Grotesk carries all body, label, form and interface text. Both are variable
 * fonts on Google Fonts, so no `weight` is declared — the whole axis ships and
 * the type scale in globals.css picks the weights it needs.
 */
const epilogue = Epilogue({
  subsets: ["latin"],
  variable: "--font-epilogue",
  display: "swap",
});

const hankenGrotesk = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: APP_NAME,
    template: `%s · ${APP_NAME}`,
  },
  description: APP_DESCRIPTION,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${epilogue.variable} ${hankenGrotesk.variable}`}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
