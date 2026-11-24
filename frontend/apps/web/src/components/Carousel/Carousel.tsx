import { type ReactNode, Children, useCallback, useEffect, useRef, useState } from 'react';

import { useDeviceLayout } from '@ci/common';
import { cn, IconButton } from '@ci/shadcn';
import { ChevronLeft, ChevronRight } from '@ci/shadcn/icons';
import useEmblaCarousel, { type UseEmblaCarouselType } from 'embla-carousel-react';
import { useTranslation } from 'react-i18next';

type EmblaCarouselType = UseEmblaCarouselType[1];

interface CarouselProps {
  children: ReactNode;
  /** Additional CSS classes for the carousel elements */
  className?: string;
  containerClassName?: string;
  slideClassName?: string;
  initialIndex?: number;
}

export function Carousel({
  children,
  className,
  containerClassName,
  slideClassName,
  initialIndex = 0,
}: CarouselProps) {
  const { t } = useTranslation();
  const { isMobile } = useDeviceLayout();

  const hasAutoScrolled = useRef<boolean>(false);

  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: 'start',
    containScroll: 'trimSnaps',
    dragFree: true,
    // We could expose this as a property, for now we're
    // explicitly setting it to the default value.
    loop: false,
    ...(isMobile && {
      dragFree: false,
      skipSnaps: false,
    }),
  });

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

  // Jump to selected item on mount.
  useEffect(() => {
    if (!emblaApi) {
      return;
    }

    if (hasAutoScrolled.current) {
      return;
    }

    if (initialIndex < 0) {
      return;
    }

    emblaApi.scrollTo(initialIndex, true);
    hasAutoScrolled.current = true;
  }, [emblaApi, initialIndex]);

  if (isMobile) {
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
    <div className="space-y-1">
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
        <IconButton
          variant="ghost"
          size="icon-sm"
          className="cursor-pointer"
          onClick={scrollPrev}
          disabled={!canScrollPrev}
          label={t('CAROUSEL_PREVIOUS')}
        >
          <ChevronLeft className="h-4 w-4" />
        </IconButton>

        <div className="flex items-center justify-center">
          {scrollSnaps.map((_, index) => (
            <IconButton
              key={index}
              variant="ghost"
              size="icon-sm"
              className="cursor-pointer"
              onClick={() => scrollTo(index)}
              label={t('CAROUSEL_GO_TO_SLIDE', { number: index + 1 })}
            >
              <div
                className={cn(
                  'h-2 w-2 rounded-full transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-200',
                  index === selectedIndex ? 'bg-slate-800 scale-115' : 'bg-slate-300',
                )}
              ></div>
            </IconButton>
          ))}
        </div>

        <IconButton
          variant="ghost"
          size="icon-sm"
          className="cursor-pointer"
          onClick={scrollNext}
          disabled={!canScrollNext}
          label={t('CAROUSEL_NEXT')}
        >
          <ChevronRight className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  );
}
