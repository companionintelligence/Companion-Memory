import { type ReactNode, Children, useCallback, useEffect, useState } from 'react';

import { Button, cn } from '@ci/shadcn';
import { ChevronLeft, ChevronRight } from '@ci/shadcn/icons';
import useEmblaCarousel, { type UseEmblaCarouselType } from 'embla-carousel-react';

type EmblaCarouselType = UseEmblaCarouselType[1];

interface CarouselProps {
  children: ReactNode;
  /** Additional CSS classes for the carousel elements */
  className?: string;
  containerClassName?: string;
  slideClassName?: string;
  mobile?: boolean;
}

export function Carousel({
  children,
  className,
  containerClassName,
  slideClassName,
  mobile = false,
}: CarouselProps) {
  const [emblaRef, emblaApi] = useEmblaCarousel(
    !mobile
      ? {
          align: 'start',
          containScroll: 'trimSnaps',
          dragFree: true,
          // We could expose this as a property, for now we're
          // explicitly setting it to the default value.
          loop: false,
        }
      : {
          align: 'start',
          dragFree: false,
          skipSnaps: false,
        },
  );

  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollSnaps, setScrollSnaps] = useState<number[]>([]);

  const scrollPrev = useCallback(() => emblaApi?.scrollPrev(), [emblaApi]);
  const scrollNext = useCallback(() => emblaApi?.scrollNext(), [emblaApi]);
  const scrollTo = useCallback((index: number) => emblaApi?.scrollTo(index), [emblaApi]);

  useEffect(() => {
    if (!emblaApi) {
      return;
    }

    const onUpdate = (api: EmblaCarouselType) => {
      if (api) {
        setScrollSnaps(api.scrollSnapList());
        setSelectedIndex(api.selectedScrollSnap());
        setCanScrollPrev(api.canScrollPrev());
        setCanScrollNext(api.canScrollNext());
      }
    };

    emblaApi.on('select', onUpdate);
    emblaApi.on('reInit', onUpdate);

    onUpdate(emblaApi);

    return () => {
      emblaApi.off('select', onUpdate);
      emblaApi.off('reInit', onUpdate);
    };
  }, [emblaApi]);

  if (mobile) {
    return (
      <div ref={emblaRef} className={cn(className, 'overflow-hidden')}>
        <div className={cn(containerClassName, 'flex will-change-transform')}>
          {Children.map(children, (child, index) => (
            <div key={index} className={cn('min-w-0 flex-none basis-full', slideClassName)}>
              {child}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div ref={emblaRef} className={cn(className, 'overflow-hidden')}>
        <div className={cn(containerClassName, 'flex will-change-transform')}>
          {Children.map(children, (child, index) => (
            <div key={index} className={cn('min-w-0 flex-none basis-full', slideClassName)}>
              {child}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-center">
        <Button
          variant="ghost"
          size="icon"
          className="cursor-pointer"
          onClick={scrollPrev}
          disabled={!canScrollPrev}
          aria-label="Previous slide"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <div className="flex items-center justify-center">
          {scrollSnaps.map((_, index) => (
            <Button
              key={index}
              variant="ghost"
              size="icon"
              className="cursor-pointer"
              onClick={() => scrollTo(index)}
              aria-label={`Go to slide ${index + 1}`}
            >
              <div
                className={cn(
                  'h-2 w-2 m-2 rounded-full transition-all duration-200',
                  index === selectedIndex ? 'bg-slate-800 scale-115' : 'bg-slate-300',
                )}
              ></div>
            </Button>
          ))}
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="cursor-pointer"
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
