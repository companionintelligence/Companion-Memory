-- Retire the standalone "inventory" identity: `ci.inventory` becomes
-- `ci.objects`.
--
-- WHY `objects` AND NOT `things`
--
-- Every sibling of this table already spells the noun `object` — the PK column
-- `object_id`, `ci.object_identifiers`, `ci.object_observations`
-- (`resolved_object_id`), `merged_into_object_id`, `parent_object_id`,
-- `receipt_line_items.minted_object_id` — as do ObjectPromoteStage,
-- ObjectMintService and ObjectMergeService. Renaming to `things` would force a
-- rename of a dozen brand-new columns and STILL leave `object_identifiers`
-- mismatched. So the layering is explicit and permanent:
--
--     `object` is the database / internal noun.
--     `Thing`  is the product / UI noun.
--
-- Exactly the split `ci.entities` already uses for Person. Nothing about
-- `object_id` changes here.
--
-- WHAT POSTGRES DOES NOT DO FOR YOU
--
-- `ALTER TABLE … RENAME TO` carries the indexes, constraints and inbound
-- foreign keys across intact, but it does NOT rename them: without the
-- statements below the renamed table would still be covered by
-- `inventory_pkey`, `inventory_source_triple_uniq`,
-- `inventory_lifecycle_state_check` and thirty-odd others, so every error
-- message and every `\d` would keep saying inventory. Each one is renamed
-- explicitly. Renaming the PRIMARY KEY constraint renames its backing index
-- with it, which is why `inventory_pkey` is not in the ALTER INDEX list.
--
-- The two inbound foreign keys from other tables
-- (`object_observations_resolved_object_id_fkey`,
-- `receipt_line_items_minted_object_id_fkey`) already say object and are left
-- alone.
--
-- THE DATA HALF
--
-- `ci.entities.linked_table` stores the table name as DATA — literally the
-- string 'inventory' for every Item base row. Renaming the table without
-- rewriting those rows silently dangles every graph link into an Item, so the
-- UPDATE below is not optional bookkeeping, it is half the migration. The
-- pipeline ledger rows keyed on the `promote.edge_inventory` stage id are
-- rewritten for the same reason: the stage keeps its cursor instead of
-- restarting from zero under its new name.

-- migrate:up
ALTER TABLE ci.inventory RENAME TO objects;

ALTER TABLE ci.objects RENAME CONSTRAINT inventory_acquired_from_entity_id_fkey TO objects_acquired_from_entity_id_fkey;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_acquisition_line_item_id_fkey TO objects_acquisition_line_item_id_fkey;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_acquisition_method_check TO objects_acquisition_method_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_acquisition_receipt_id_fkey TO objects_acquisition_receipt_id_fkey;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_color_hex_check TO objects_color_hex_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_colors_check TO objects_colors_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_composition_check TO objects_composition_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_composition_not_null TO objects_composition_not_null;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_condition_check TO objects_condition_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_digital_is_incorporeal_check TO objects_digital_is_incorporeal_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_dimensions_positive_check TO objects_dimensions_positive_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_entity_type_check TO objects_entity_type_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_entity_type_not_null TO objects_entity_type_not_null;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_identity_confidence_check TO objects_identity_confidence_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_identity_confidence_not_null TO objects_identity_confidence_not_null;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_identity_method_check TO objects_identity_method_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_last_seen_place_entity_id_fkey TO objects_last_seen_place_entity_id_fkey;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_lifecycle_state_check TO objects_lifecycle_state_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_lifecycle_state_not_null TO objects_lifecycle_state_not_null;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_mass_positive_check TO objects_mass_positive_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_materials_check TO objects_materials_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_merged_into_object_id_fkey TO objects_merged_into_object_id_fkey;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_object_id_entities_fk TO objects_object_id_entities_fk;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_object_id_not_null TO objects_object_id_not_null;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_owner_user_id_fkey TO objects_owner_user_id_fkey;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_parent_object_id_fkey TO objects_parent_object_id_fkey;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_pkey TO objects_pkey;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_product_id_fkey TO objects_product_id_fkey;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_quantity_check TO objects_quantity_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_quantity_not_null TO objects_quantity_not_null;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_unit_system_check TO objects_unit_system_check;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_user_id_fkey TO objects_user_id_fkey;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_user_id_not_null TO objects_user_id_not_null;
ALTER TABLE ci.objects RENAME CONSTRAINT inventory_volume_positive_check TO objects_volume_positive_check;
ALTER INDEX ci.inventory_acquired_at_idx RENAME TO objects_acquired_at_idx;
ALTER INDEX ci.inventory_acquired_from_idx RENAME TO objects_acquired_from_idx;
ALTER INDEX ci.inventory_brand_model_idx RENAME TO objects_brand_model_idx;
ALTER INDEX ci.inventory_category_idx RENAME TO objects_category_idx;
ALTER INDEX ci.inventory_colors_gin_idx RENAME TO objects_colors_gin_idx;
ALTER INDEX ci.inventory_condition_idx RENAME TO objects_condition_idx;
ALTER INDEX ci.inventory_expires_at_idx RENAME TO objects_expires_at_idx;
ALTER INDEX ci.inventory_last_seen_idx RENAME TO objects_last_seen_idx;
ALTER INDEX ci.inventory_lifecycle_idx RENAME TO objects_lifecycle_idx;
ALTER INDEX ci.inventory_line_item_idx RENAME TO objects_line_item_idx;
ALTER INDEX ci.inventory_live_keyset_idx RENAME TO objects_live_keyset_idx;
ALTER INDEX ci.inventory_location_gist_idx RENAME TO objects_location_gist_idx;
ALTER INDEX ci.inventory_maintenance_idx RENAME TO objects_maintenance_idx;
ALTER INDEX ci.inventory_materials_gin_idx RENAME TO objects_materials_gin_idx;
ALTER INDEX ci.inventory_merged_idx RENAME TO objects_merged_idx;
ALTER INDEX ci.inventory_owner_idx RENAME TO objects_owner_idx;
ALTER INDEX ci.inventory_parent_idx RENAME TO objects_parent_idx;
ALTER INDEX ci.inventory_product_idx RENAME TO objects_product_idx;
ALTER INDEX ci.inventory_receipt_idx RENAME TO objects_receipt_idx;
ALTER INDEX ci.inventory_source_triple_uniq RENAME TO objects_source_triple_uniq;
ALTER INDEX ci.inventory_user_idx RENAME TO objects_user_idx;
ALTER INDEX ci.inventory_warranty_idx RENAME TO objects_warranty_idx;

COMMENT ON TABLE ci.objects IS
  'Owned physical (and digital) units — the detail half of the Item CTI pair, sharing object_id with its ci.entities base row. Named for object_id and the ci.object_* family around it; the product/UI noun for a row here is "Thing".';

-- ci.entities.linked_table is data, not DDL.
UPDATE ci.entities SET linked_table = 'objects' WHERE linked_table = 'inventory';

-- The edge-projection leg is renamed promote.edge_inventory -> promote.edge_object
-- in the same change; carry its ledger across so it resumes rather than restarts.
UPDATE ci.pipeline_state       SET stage = 'promote.edge_object' WHERE stage = 'promote.edge_inventory';
UPDATE ci.pipeline_schedule    SET stage = 'promote.edge_object' WHERE stage = 'promote.edge_inventory';
UPDATE ci.pipeline_shards      SET stage = 'promote.edge_object' WHERE stage = 'promote.edge_inventory';
UPDATE ci.pipeline_dead_letters SET stage = 'promote.edge_object' WHERE stage = 'promote.edge_inventory';

-- The bulk-capture raw log keys idempotency on
-- (user_id, destination, source_type, source_system, source_id), and the
-- destination this feature writes is renamed 'inventory' -> 'things' in the
-- same change (`/v1/things`, `BulkIngestController.flushThings`). Rewriting the
-- stored value is what keeps a replayed capture landing on its existing log row
-- instead of inserting a second one under the new name. `kind` is the same
-- string one level down.
UPDATE ci.capture_events
   SET destination = 'things',
       kind = CASE WHEN kind = 'inventory.item' THEN 'thing.item' ELSE kind END
 WHERE destination = 'inventory';

-- Descriptive provenance stamped on each projected edge by
-- deterministicEdgeMatrix's `inventory.located_at` rule, which is now
-- `object.located_at`. Narrowed by relationship_type (indexed) so this does not
-- scan every edge in ci.relationships.
UPDATE ci.relationships
   SET properties = properties
         || jsonb_build_object('rule', 'object.located_at',
                               'derived_from', 'objects.last_seen_place_entity_id')
 WHERE relationship_type = 'LOCATED_AT'
   AND properties->>'rule' = 'inventory.located_at';

-- migrate:down
UPDATE ci.relationships
   SET properties = properties
         || jsonb_build_object('rule', 'inventory.located_at',
                               'derived_from', 'inventory.last_seen_place_entity_id')
 WHERE relationship_type = 'LOCATED_AT'
   AND properties->>'rule' = 'object.located_at';

UPDATE ci.capture_events
   SET destination = 'inventory',
       kind = CASE WHEN kind = 'thing.item' THEN 'inventory.item' ELSE kind END
 WHERE destination = 'things';

UPDATE ci.pipeline_dead_letters SET stage = 'promote.edge_inventory' WHERE stage = 'promote.edge_object';
UPDATE ci.pipeline_shards      SET stage = 'promote.edge_inventory' WHERE stage = 'promote.edge_object';
UPDATE ci.pipeline_schedule    SET stage = 'promote.edge_inventory' WHERE stage = 'promote.edge_object';
UPDATE ci.pipeline_state       SET stage = 'promote.edge_inventory' WHERE stage = 'promote.edge_object';

UPDATE ci.entities SET linked_table = 'inventory' WHERE linked_table = 'objects';

COMMENT ON TABLE ci.objects IS NULL;

ALTER TABLE ci.objects RENAME TO inventory;

ALTER TABLE ci.inventory RENAME CONSTRAINT objects_acquired_from_entity_id_fkey TO inventory_acquired_from_entity_id_fkey;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_acquisition_line_item_id_fkey TO inventory_acquisition_line_item_id_fkey;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_acquisition_method_check TO inventory_acquisition_method_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_acquisition_receipt_id_fkey TO inventory_acquisition_receipt_id_fkey;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_color_hex_check TO inventory_color_hex_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_colors_check TO inventory_colors_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_composition_check TO inventory_composition_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_composition_not_null TO inventory_composition_not_null;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_condition_check TO inventory_condition_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_digital_is_incorporeal_check TO inventory_digital_is_incorporeal_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_dimensions_positive_check TO inventory_dimensions_positive_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_entity_type_check TO inventory_entity_type_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_entity_type_not_null TO inventory_entity_type_not_null;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_identity_confidence_check TO inventory_identity_confidence_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_identity_confidence_not_null TO inventory_identity_confidence_not_null;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_identity_method_check TO inventory_identity_method_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_last_seen_place_entity_id_fkey TO inventory_last_seen_place_entity_id_fkey;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_lifecycle_state_check TO inventory_lifecycle_state_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_lifecycle_state_not_null TO inventory_lifecycle_state_not_null;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_mass_positive_check TO inventory_mass_positive_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_materials_check TO inventory_materials_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_merged_into_object_id_fkey TO inventory_merged_into_object_id_fkey;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_object_id_entities_fk TO inventory_object_id_entities_fk;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_object_id_not_null TO inventory_object_id_not_null;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_owner_user_id_fkey TO inventory_owner_user_id_fkey;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_parent_object_id_fkey TO inventory_parent_object_id_fkey;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_pkey TO inventory_pkey;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_product_id_fkey TO inventory_product_id_fkey;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_quantity_check TO inventory_quantity_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_quantity_not_null TO inventory_quantity_not_null;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_unit_system_check TO inventory_unit_system_check;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_user_id_fkey TO inventory_user_id_fkey;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_user_id_not_null TO inventory_user_id_not_null;
ALTER TABLE ci.inventory RENAME CONSTRAINT objects_volume_positive_check TO inventory_volume_positive_check;
ALTER INDEX ci.objects_acquired_at_idx RENAME TO inventory_acquired_at_idx;
ALTER INDEX ci.objects_acquired_from_idx RENAME TO inventory_acquired_from_idx;
ALTER INDEX ci.objects_brand_model_idx RENAME TO inventory_brand_model_idx;
ALTER INDEX ci.objects_category_idx RENAME TO inventory_category_idx;
ALTER INDEX ci.objects_colors_gin_idx RENAME TO inventory_colors_gin_idx;
ALTER INDEX ci.objects_condition_idx RENAME TO inventory_condition_idx;
ALTER INDEX ci.objects_expires_at_idx RENAME TO inventory_expires_at_idx;
ALTER INDEX ci.objects_last_seen_idx RENAME TO inventory_last_seen_idx;
ALTER INDEX ci.objects_lifecycle_idx RENAME TO inventory_lifecycle_idx;
ALTER INDEX ci.objects_line_item_idx RENAME TO inventory_line_item_idx;
ALTER INDEX ci.objects_live_keyset_idx RENAME TO inventory_live_keyset_idx;
ALTER INDEX ci.objects_location_gist_idx RENAME TO inventory_location_gist_idx;
ALTER INDEX ci.objects_maintenance_idx RENAME TO inventory_maintenance_idx;
ALTER INDEX ci.objects_materials_gin_idx RENAME TO inventory_materials_gin_idx;
ALTER INDEX ci.objects_merged_idx RENAME TO inventory_merged_idx;
ALTER INDEX ci.objects_owner_idx RENAME TO inventory_owner_idx;
ALTER INDEX ci.objects_parent_idx RENAME TO inventory_parent_idx;
ALTER INDEX ci.objects_product_idx RENAME TO inventory_product_idx;
ALTER INDEX ci.objects_receipt_idx RENAME TO inventory_receipt_idx;
ALTER INDEX ci.objects_source_triple_uniq RENAME TO inventory_source_triple_uniq;
ALTER INDEX ci.objects_user_idx RENAME TO inventory_user_idx;
ALTER INDEX ci.objects_warranty_idx RENAME TO inventory_warranty_idx;
