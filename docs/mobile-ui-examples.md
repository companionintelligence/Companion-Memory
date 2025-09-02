# Mobile UI Implementation Examples

This document provides specific code examples for implementing the mobile UI improvements outlined in `MOBILE_UI_IMPROVEMENTS.md`.

## 1. Enhanced ChatInput for Mobile

### Current Issues:
- Button size (8x8) may be too small for comfortable mobile use
- No mobile-specific keyboard optimizations
- Limited touch feedback

### Improved Implementation:

```tsx
// Enhanced ChatInput with mobile optimizations
import { useDeviceLayout } from '@/hooks/use-device-layout';

function EnhancedChatInput(props: Props, forwardedRef: ForwardedRef<HTMLTextAreaElement>) {
  const { isMobile } = useDeviceLayout();
  
  // Mobile-optimized button size
  const buttonSize = isMobile ? "md" : "sm";
  const buttonClasses = cn(
    "cursor-pointer active:scale-90 transition-transform duration-200 ease-out will-change-transform",
    isMobile && "min-h-[44px] min-w-[44px]", // Ensure 44px touch target
    !isMobile && "h-8 w-8 p-0"
  );

  return (
    <div className={cn(
      "w-full flex items-center gap-2",
      isMobile && "gap-3" // Larger gaps on mobile
    )}>
      {/* Attach button with mobile optimizations */}
      <Button
        type="button"
        size={buttonSize}
        variant="ghost"
        className={buttonClasses}
        onClick={handleAttach}
      >
        <Plus className={cn("h-4 w-4", isMobile && "h-5 w-5")} />
      </Button>

      {/* Input container with mobile-first styling */}
      <div className={cn(
        "w-full flex items-center p-1.5 rounded-md border",
        "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
        isMobile && "p-2" // More padding on mobile
      )}>
        <Textarea
          {...field}
          ref={forwardedRef}
          placeholder={placeholder}
          className={cn(
            "w-full resize-none border-0 outline-none ring-0 shadow-none",
            "text-base leading-relaxed", // Prevent zoom on iOS
            isMobile && "min-h-[44px]" // Larger touch area
          )}
          // Mobile-specific attributes
          autoComplete="off"
          autoCorrect="on"
          autoCapitalize="sentences"
          spellCheck="true"
          onKeyDown={handleEnterSubmit}
        />

        {/* Voice input button */}
        <Button
          type="button"
          size={buttonSize}
          variant="ghost"
          className={buttonClasses}
          onClick={handleRecord}
        >
          <Mic className={cn("h-4 w-4", isMobile && "h-5 w-5")} />
        </Button>

        {/* Send button */}
        <Button
          type={streaming ? 'button' : 'submit'}
          size={buttonSize}
          className={cn(buttonClasses, "ml-1")}
          onClick={streaming ? handleStop : undefined}
        >
          <SendIcon className={cn("h-4 w-4", isMobile && "h-5 w-5")} />
        </Button>
      </div>
    </div>
  );
}
```

## 2. Mobile-Optimized Navigation Component

### Bottom Navigation for Mobile

```tsx
// components/MobileBottomNav.tsx
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { Home, Search, MessageSquare, Settings, User } from '@ci/shadcn/icons';

interface MobileBottomNavProps {
  currentPath: string;
}

export function MobileBottomNav({ currentPath }: MobileBottomNavProps) {
  const { isMobile } = useDeviceLayout();

  if (!isMobile) return null;

  const navItems = [
    { icon: Home, label: 'Home', path: '/' },
    { icon: Search, label: 'Search', path: '/search' },
    { icon: MessageSquare, label: 'Chat', path: '/chat' },
    { icon: Settings, label: 'Settings', path: '/settings' },
    { icon: User, label: 'Profile', path: '/profile' },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-sm border-t">
      <div className="flex justify-around items-center py-2 px-4 safe-area-inset-bottom">
        {navItems.map(({ icon: Icon, label, path }) => {
          const isActive = currentPath === path;
          return (
            <Link
              key={path}
              to={path}
              className={cn(
                "flex flex-col items-center justify-center",
                "min-h-[48px] min-w-[48px] px-2 py-1",
                "rounded-lg transition-colors",
                "touch-manipulation", // Optimize for touch
                isActive 
                  ? "text-primary bg-primary/10" 
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-5 w-5 mb-1" />
              <span className="text-xs font-medium">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
```

## Implementation Notes

### CSS Utilities for Mobile

```css
/* Add to global CSS */
.touch-manipulation {
  touch-action: manipulation;
}

.safe-area-inset-bottom {
  padding-bottom: env(safe-area-inset-bottom);
}

.safe-area-inset-top {
  padding-top: env(safe-area-inset-top);
}

/* Prevent zoom on iOS */
.prevent-zoom {
  font-size: 16px;
}

/* Better mobile focus styles */
.mobile-focus:focus {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
}
```

### Tailwind Config Additions

```js
// tailwind.config.js additions
module.exports = {
  theme: {
    extend: {
      spacing: {
        'safe-top': 'env(safe-area-inset-top)',
        'safe-bottom': 'env(safe-area-inset-bottom)',
        'safe-left': 'env(safe-area-inset-left)',
        'safe-right': 'env(safe-area-inset-right)',
      },
      minHeight: {
        'touch': '44px', // Apple's recommended minimum touch target
      },
      minWidth: {
        'touch': '44px',
      },
    },
  },
  plugins: [
    // Add safe area plugin if needed
  ],
};
```

These examples demonstrate practical implementations of the mobile UI improvements, focusing on touch-friendly interfaces, proper sizing, and mobile-specific interactions.