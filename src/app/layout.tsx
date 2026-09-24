import type { Metadata } from "next";
import { JetBrains_Mono, Roboto_Flex } from "next/font/google";
import { GlobalMusic } from "./GlobalMusic";
import "./globals.css";

// Material 3's typeface (variable, so every type-scale weight is one file).
const robotoFlex = Roboto_Flex({
  variable: "--font-roboto-flex",
  subsets: ["latin"],
});

// Backs --font-mono (dice totals, numerals, code) in tokens.css.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "BeyondDNDBeyond", template: "%s · BeyondDNDBeyond" },
  description: "A 3D virtual tabletop for Dungeons & Dragons 5e — sit around the table with your party online.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${robotoFlex.variable} ${jetbrainsMono.variable}`}>
      <body>
        <GlobalMusic />
        {children}
      </body>
    </html>
  );
}
