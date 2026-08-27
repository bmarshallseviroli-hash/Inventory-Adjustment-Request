/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 *
 * ia_recall_field_defaults_cs.js
 * Recall support: for users holding the [Seviroli] - Inventory
 * Adjustment Role (internal id 1695), locks the Adjustment Location
 * field (IAR header, customrecord_inventory_adjustment_reques) and the
 * Item field (IAR line, customrecord_ia_request_lines) to the recall
 * values so the wrong item/location can never even be picked in the UI.
 *
 * Deploy this on whichever entry form(s) role 1695 uses for the header
 * and line records - it only acts on whichever of the two fields
 * actually exists on the form it's running on, so one deployment can
 * cover both if they share a form, or it can be deployed twice.
 *
 * This is a convenience/defense-in-depth layer only. The real
 * enforcement lives server-side in IA Recall Approval Bypass.js
 * (header) and Inventory Request Line Validation.js (line) - both
 * force these same values on save regardless of what the client sends.
 */
define(['N/runtime'], function (runtime) {

    var BYPASS_ROLE_ID     = 1695; // [Seviroli] - Inventory Adjustment Role
    var BYPASS_LOCATION_ID = 11;   // Seviroli Food Garden City
    var BYPASS_ITEM_ID     = 11953; // SAU290B150

    function isBypassRole() {
        try {
            var currentUser = runtime.getCurrentUser();
            return !!currentUser && Number(currentUser.role) === BYPASS_ROLE_ID;
        } catch (e) {
            return false;
        }
    }

    function lockField(rec, fieldId, value) {
        var field = rec.getField({ fieldId: fieldId });
        if (!field) { return; }
        rec.setValue({ fieldId: fieldId, value: value, ignoreFieldChange: true });
        field.isDisabled = true;
    }

    function pageInit(scriptContext) {
        if (!isBypassRole()) { return; }
        var rec = scriptContext.currentRecord;
        lockField(rec, 'custrecord_adjustment_location', BYPASS_LOCATION_ID);
        lockField(rec, 'custrecord_item', BYPASS_ITEM_ID);
    }

    function saveRecord(scriptContext) {
        if (!isBypassRole()) { return true; }
        var rec = scriptContext.currentRecord;
        if (rec.getField({ fieldId: 'custrecord_adjustment_location' })) {
            rec.setValue({ fieldId: 'custrecord_adjustment_location', value: BYPASS_LOCATION_ID, ignoreFieldChange: true });
        }
        if (rec.getField({ fieldId: 'custrecord_item' })) {
            rec.setValue({ fieldId: 'custrecord_item', value: BYPASS_ITEM_ID, ignoreFieldChange: true });
        }
        return true;
    }

    return {
        pageInit: pageInit,
        saveRecord: saveRecord
    };
});
