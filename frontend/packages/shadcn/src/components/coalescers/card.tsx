import {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
} from '../ui/card';

type CardComponent = typeof Card & {
  Header: typeof CardHeader;
  Footer: typeof CardFooter;
  Title: typeof CardTitle;
  Action: typeof CardAction;
  Description: typeof CardDescription;
  Content: typeof CardContent;
};

const AugmentedCard = Card as CardComponent;

AugmentedCard.Header = CardHeader;
AugmentedCard.Footer = CardFooter;
AugmentedCard.Title = CardTitle;
AugmentedCard.Action = CardAction;
AugmentedCard.Description = CardDescription;
AugmentedCard.Content = CardContent;

export { AugmentedCard as Card };
