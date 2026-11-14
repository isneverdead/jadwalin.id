import { ImageResponse } from "next/og";

// iOS home-screen icon (180x180). Same mark as icon.svg: white "j" whose dot is an amber "locked slot".
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#0369a1" }}>
        <svg width="180" height="180" viewBox="0 0 64 64">
          <path d="M37 26v15q0 11-11 11" fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="37" cy="13.5" r="5.5" fill="#f5a524" />
        </svg>
      </div>
    ),
    size,
  );
}
