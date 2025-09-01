import React, { useState, useEffect } from 'react';
import { Button } from '@ci/shadcn/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ci/shadcn/components/ui/card';

export function PopupApp() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    // Check if user is logged in by checking for auth token
    chrome.storage.local.get(['authToken'], (result) => {
      setIsLoggedIn(!!result.authToken);
    });
  }, []);

  const openMainApp = () => {
    chrome.tabs.create({
      url: 'https://companionintelligence.com'
    });
    window.close();
  };

  const openDevApp = () => {
    chrome.tabs.create({
      url: 'http://dev.companionintelligence.com'
    });
    window.close();
  };

  const logout = () => {
    chrome.storage.local.remove(['authToken'], () => {
      setIsLoggedIn(false);
    });
  };

  return (
    <div className="w-80 p-4">
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-lg">Companion Intelligence</CardTitle>
          <CardDescription>
            Your AI companion for enhanced productivity
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button 
            onClick={openMainApp} 
            className="w-full"
            variant="default"
          >
            Open Companion Intelligence
          </Button>
          
          <Button 
            onClick={openDevApp} 
            className="w-full"
            variant="outline"
            size="sm"
          >
            Open Dev Environment
          </Button>

          {isLoggedIn && (
            <Button 
              onClick={logout} 
              className="w-full"
              variant="ghost"
              size="sm"
            >
              Logout
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}