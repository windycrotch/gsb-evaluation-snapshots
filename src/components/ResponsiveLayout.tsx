import React, { useState } from 'react';
import { Menu, X } from 'lucide-react';

interface ResponsiveLayoutProps {
  sidebar?: React.ReactNode;
  children: React.ReactNode;
  panel?: React.ReactNode;
}

export const ResponsiveLayout: React.FC<ResponsiveLayoutProps> = ({ sidebar, children, panel }) => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <div className="flex h-screen bg-gray-900">
      {/* Sidebar Toggle Button */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="hidden max-lg:flex fixed left-4 top-20 z-40 p-2 bg-gray-800 text-white rounded hover:bg-gray-700 transition-colors"
        title="Toggle Sidebar"
      >
        {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
      </button>
      {panel && (
        <button
          onClick={() => setPanelOpen(!panelOpen)}
          className="hidden max-lg:flex fixed right-4 top-20 z-40 p-2 bg-gray-800 text-white rounded hover:bg-gray-700"
          aria-label="Toggle panel"
        >
          {panelOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      )}

      {/* Overlay when sidebar is open on mobile */}
      {sidebarOpen && (
        <div
          className="hidden max-lg:block fixed inset-0 bg-black bg-opacity-50 z-30"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      {sidebar && (
        <div
          className={`
            transition-transform duration-300 fixed max-lg:absolute max-lg:left-0 max-lg:top-0 max-lg:h-full z-30
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full max-lg:hidden'}
            lg:relative lg:translate-x-0
          `}
        >
          {sidebar}
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">{children}</div>

      {/* Panel */}
      {panel && (
        <div
          className={`
            transition-transform duration-300 fixed max-lg:absolute max-lg:right-0 max-lg:top-0 max-lg:h-full z-30
            ${panelOpen ? 'translate-x-0' : 'translate-x-full max-lg:hidden'}
            lg:relative lg:translate-x-0
          `}
        >
          {panel}
        </div>
      )}
    </div>
  );
};
