import { Button } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import balloonImage from '@/assets/balloon-bouquet.jpg';

export function SplashPage() {
  return (
    <div className="flex flex-col md:flex-row min-h-svh">
      {/* Image Section */}
      <div className="w-full md:w-1/2 relative">
        <img src={balloonImage} alt="Colorful balloon bouquet" className="w-full h-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/60 to-transparent flex items-center">
          <div className="p-8 md:p-12 text-white max-w-md">
            <h1 className="text-4xl md:text-5xl font-bold mb-4">Companion Intelligence</h1>
            <p className="text-lg md:text-xl mb-6">
              Your personal AI assistant that helps you navigate daily tasks with ease.
            </p>
          </div>
        </div>
      </div>

      {/* Content Section */}
      <div className="w-full md:w-1/2 flex flex-col justify-center items-center p-8 md:p-12">
        <div className="max-w-md text-center md:text-left">
          <h2 className="text-3xl font-bold mb-4">Your Personal Assistant</h2>
          <p className="text-lg mb-8">
            Companion Intelligence is a personal AI that helps you manage your schedule, remember important
            details, and simplify your daily life. Think of it as your personal assistant, always ready to
            help.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center md:justify-start">
            <Button variant="outline" asChild size="lg" className="px-8">
              <Link to="/login">Log In</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
