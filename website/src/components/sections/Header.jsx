import React from 'react'
import { Home } from 'lucide-react'

export function Header({ currentSection, setCurrentSection }) {
  return (
    <header className="bg-white shadow-sm border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center space-x-3">
            <Home className="h-8 w-8 text-blue-600" />
            <h1 className="text-2xl font-bold text-gray-900">VirtualStage Pro</h1>
          </div>
          <nav className="flex space-x-8">
            <button 
              onClick={() => setCurrentSection('landing')}
              className={`transition-colors ${
                currentSection === 'landing' 
                  ? 'text-blue-600 font-medium' 
                  : 'text-gray-700 hover:text-blue-600'
              }`}
            >
              Home
            </button>
            <button 
              onClick={() => setCurrentSection('upload')}
              className={`transition-colors ${
                currentSection === 'upload' 
                  ? 'text-blue-600 font-medium' 
                  : 'text-gray-700 hover:text-blue-600'
              }`}
            >
              Upload
            </button>
            <button 
              onClick={() => setCurrentSection('pricing')}
              className={`transition-colors ${
                currentSection === 'pricing' 
                  ? 'text-blue-600 font-medium' 
                  : 'text-gray-700 hover:text-blue-600'
              }`}
            >
              Pricing
            </button>
          </nav>
        </div>
      </div>
    </header>
  )
}