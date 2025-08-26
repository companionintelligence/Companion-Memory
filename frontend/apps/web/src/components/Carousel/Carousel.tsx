import React, { useCallback, useEffect, useState } from 'react';

import { Button, cn } from '@ci/shadcn';
import { ChevronLeft, ChevronRight } from '@ci/shadcn/icons';
import useEmblaCarousel from 'embla-carousel-react';

interface CarouselProps {
  /** React children to render as carousel slides */
  children: React.ReactNode;
  /** Title displayed above the carousel */
  title?: string;
  /** Additional CSS classes for the carousel container */
  className?: string;
}

export function Carousel({ children, title, className }: CarouselProps) {
  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: 'start',
    containScroll: 'trimSnaps',
    dragFree: true,
  });

  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);

  const scrollPrev = useCallback(() => {
    if (emblaApi) {
      emblaApi.scrollPrev();
    }
  }, [emblaApi]);

  const scrollNext = useCallback(() => {
    if (emblaApi) {
      emblaApi.scrollNext();
    }
  }, [emblaApi]);

  const onSelect = useCallback(() => {
    if (!emblaApi) {
      return;
    }

    setCanScrollPrev(emblaApi.canScrollPrev());
    setCanScrollNext(emblaApi.canScrollNext());
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) {
      return;
    }

    onSelect();
    emblaApi.on('select', onSelect);
    emblaApi.on('reInit', onSelect);

    return () => {
      emblaApi.off('select', onSelect);
      emblaApi.off('reInit', onSelect);
    };
  }, [emblaApi, onSelect]);

  return (
    <div className={className}>
      {title && <h2 className="text-xl font-semibold text-gray-800 mb-4">{title}</h2>}
      <div className="relative">
        <div className="embla overflow-hidden w-full relative" ref={emblaRef}>
          <div
            className="embla__container flex flex-row select-none touch-none"
            style={{
              WebkitTouchCallout: 'none',
              WebkitTapHighlightColor: 'transparent',
              willChange: 'transform',
            }}
          >
            {React.Children.map(children, (child, index) => (
              <div
                key={index}
                className="embla__slide relative"
                style={{
                  flex: '0 0 550px',
                  minWidth: '550px',
                  marginRight: '24px',
                }}
              >
                {child}
              </div>
            ))}
          </div>
        </div>

        {/* Navigation Buttons */}
        <Button
          variant="outline"
          size="icon"
          className={cn(
            'absolute left-4 top-1/2 transform -translate-y-1/2 z-10 h-10 w-10 rounded-full bg-white/90 backdrop-blur-sm shadow-lg border border-gray-200 hover:bg-white transition-all duration-200',
            canScrollPrev ? 'opacity-100' : 'opacity-50 cursor-not-allowed',
          )}
          onClick={scrollPrev}
          disabled={!canScrollPrev}
          aria-label="Previous slide"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <Button
          variant="outline"
          size="icon"
          className={cn(
            'absolute right-4 top-1/2 transform -translate-y-1/2 z-10 h-10 w-10 rounded-full bg-white/90 backdrop-blur-sm shadow-lg border border-gray-200 hover:bg-white transition-all duration-200',
            canScrollNext ? 'opacity-100' : 'opacity-50 cursor-not-allowed',
          )}
          onClick={scrollNext}
          disabled={!canScrollNext}
          aria-label="Next slide"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
