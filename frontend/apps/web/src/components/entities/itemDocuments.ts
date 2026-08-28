import { gql } from '@/graphql';

import { OBJECT_IDENTIFIER_FRAGMENT } from './ObjectIdentifierList';
import { OBSERVATION_FRAGMENT } from './ObservationStrip';
import { PRODUCT_MODEL_FRAGMENT } from './ProductModelCard';

/**
 * The full read of one owned thing, shared by the Thing page and by the
 * Thing modal.
 *
 * It lives here rather than on the page because `ThingModal` used to
 * import it from `@/pages/ItemPage/ItemPage` — a component reaching up into a
 * page, which inverts the dependency direction and drags the whole page module
 * (its graph panel, evolution panel and relationship cards) into the bundle of
 * every screen that can open the modal.
 *
 * The three fragments are spread rather than re-selected so the page and its
 * child components cannot drift: the identifier list, the sightings strip and
 * the product card each declare the fields they render.
 */
export const GET_ITEM = gql(`
  query GetItem($id: ID!) {
    item(id: $id) {
      id
      name
      description
      category
      subcategory
      brand
      model
      currentValue
      purchasePrice
      condition
      quantity
      lifecycleState
      lastSeenAt
      identityConfidence
      isDigital
      acquiredAt
      acquisitionMethod
      acquiredFrom
      manufacturedAt
      expiresAt
      lengthMm
      widthMm
      heightMm
      massG
      volumeMl
      unitSystem
      colors
      colorHex
      materials
      composition
      currency
      file {
        id
        sourceUrl
      }
      tags {
        id
        label
      }
      identifiers {
        ...ObjectIdentifierData
      }
      product {
        ...ProductModelCardData
      }
      observations {
        ...ObservationStripData
      }
      acquisition {
        id
        receiptId
        lineNumber
        description
        brand
        modelNumber
        quantity
        unitPriceMinor
        totalPriceMinor
        currency
        isPhysical
      }
    }
  }
`);

// Re-exported so a consumer of the query does not have to know which component
// owns which fragment.
export { OBJECT_IDENTIFIER_FRAGMENT, OBSERVATION_FRAGMENT, PRODUCT_MODEL_FRAGMENT };
