-- migrate:up

-- Who the BlueBubbles connector belongs to.
--
-- The config row is appliance-wide, but what it reaches is one person's Mac:
-- their iMessage account, their chats, the Apple ID texts go out from. Nothing
-- recorded whose that was, so the `messaging.*` assistant tools served it to
-- every account on the appliance, and the sync filed its messages under
-- whichever account was onboarded first. `owner_user_id` records it. From now
-- on the administrator who saves the connection claims it when the row has no
-- live owner (`BlueBubblesConfigService.update`).
--
-- Backfill: the account the sync already files these messages under, which is
-- the oldest live onboarded account (`UserService.findAllOnboarded`, first row).
-- Not "the admin": on the rare appliance where those differ, the admin would
-- inherit a connector whose whole history sits in someone else's memory.
-- Only rows somebody actually configured are backfilled. A row with no host
-- and no password was minted by a page view and holds nothing yet, so it is
-- left for the first administrator who saves it to claim.
ALTER TABLE ci.bluebubbles_config
    ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES ci.users (id) ON DELETE SET NULL;

UPDATE ci.bluebubbles_config
   SET owner_user_id = (
         SELECT u.id
           FROM ci.users u
          WHERE u.onboarded = true
            AND u.deleted_at IS NULL
          ORDER BY u.created_at ASC, u.id ASC
          LIMIT 1)
 WHERE owner_user_id IS NULL
   AND (host <> '' OR password <> '');

COMMENT ON COLUMN ci.bluebubbles_config.owner_user_id IS
  'The account this BlueBubbles connector belongs to. Only this account sees and runs the messaging tools, and the sync files messages under it. Claimed by the administrator who saves the connection when there is no live owner.';

-- migrate:down

ALTER TABLE ci.bluebubbles_config DROP COLUMN IF EXISTS owner_user_id;
