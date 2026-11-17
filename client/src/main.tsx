import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { basePath, ErrorBoundary, OnScreenKeyboard, VenueAnnouncement } from "@bargames/gamekit/client";
import { AdminPage } from "./pages/AdminPage";
import { HomePage } from "./pages/HomePage";
import { RoomPage } from "./pages/RoomPage";
import { useVenue } from "./useVenue";
import "./index.css";
import "./zinger.css";

/**
 * Bar Games: keeps the venue theme applied everywhere and shows the staff announcement on
 * every page, TV views included. It follows the announcement's show (everywhere / phones /
 * TVs): the room page marks TVs as shared screens (tableMode / markSharedScreen), and the
 * strip hides itself where it doesn't belong. Off a box it renders nothing.
 */
function Venue() {
  const venue = useVenue();
  useLocation(); // re-render on navigation
  return <VenueAnnouncement ctx={venue} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter basename={basePath()}>
        <Venue />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/join/:code" element={<HomePage />} />
          <Route path="/room/:code" element={<RoomPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        {/* Kit 0.10.0: big keys for a box touchscreen with no keyboard (hidden on phones, PCs). */}
        <OnScreenKeyboard />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
