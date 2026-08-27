/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * ia_line_validation.js
 * User Event on IA Request Lines (customrecord_ia_request_lines).
 * Validates Bin/LP + Lot Number + quantity available the moment the
 * line is saved, using live InventoryBalance data (not just "does the
 * bin record exist"). Also populates "Current On Hand Available" so
 * the person entering the line can see what's actually left to write
 * off before they submit.
 *
 * Self-contained - no external library file. All Bin/Lot/quantity
 * logic below is duplicated in ia_request_approval.js on purpose, so
 * either script can be updated in place (paste new code into the
 * existing Script record) without managing a separate shared file.
 * If the validation logic changes, update BOTH files.
 *
 * Recall support: users holding the [Seviroli] - Inventory Adjustment
 * Role (internal id 1695) skip all of the above. That role exists only
 * to log Sam's Club recall returns of SAU290B150 at Garden City - see
 * the RECALL BYPASS block below.
 */
define(['N/search', 'N/query', 'N/log', 'N/record', 'N/runtime', 'N/lock'],
    function (search, query, log, record, runtime, lock) {

    // NetSuite account ID, used to build the Bin List link dropped into
    // the error message when a Bin/LP problem is found.
    var ACCOUNT_ID = '682633';

    // Suitelet that starts a cycle count. Script 4889 / Deploy 1 is the
    // "Start Cycle Count" entry point Brad provided - no bin/item
    // pre-fill parameters are exposed by this deployment.
    var CYCLE_COUNT_SCRIPT_ID = '4889';
    var CYCLE_COUNT_DEPLOY_ID = '1';

    // ------------------------------------------------------------------
    // Recall bypass - [Seviroli] - Inventory Adjustment Role
    // ------------------------------------------------------------------
    var BYPASS_ROLE_ID     = 1695; // [Seviroli] - Inventory Adjustment Role
    var BYPASS_LOCATION_ID = 11;   // Seviroli Food Garden City
    var BYPASS_ITEM_ID     = 11953; // SAU290B150
    var LP_PREFIX          = 'S';
    var LP_START_NUMBER    = 1000;
    var LP_COUNTER_LOCK_KEY = 'sams_return_bin_lp_counter';

    // customrecord_inventory_adjustment_reques -> custrecord_approval_status
    // values that count as "final" (no longer reserve quantity against
    // other requests).
    var STATUS_FINANCE_APPROVED = 4; // posted, inventory already moved
    var STATUS_REJECTED         = 7; // rejected, never posted

    // ------------------------------------------------------------------
    // Link builders
    // ------------------------------------------------------------------
    function buildBinListLink(binName) {
        var url = 'https://' + ACCOUNT_ID + '.app.netsuite.com/app/accounting/transactions/inventory/binlist.nl' +
            '?searchtype=BinNumber' +
            '&BinNumber_LOCATION=%40ALL%40' +
            '&BinNumber_BINNUMBERtype=STARTSWITH' +
            '&style=NORMAL&csv=HTML';
        if (binName) {
            url += '&BinNumber_BINNUMBER=' + encodeURIComponent(binName);
        }
        return url;
    }

    function buildCycleCountLink() {
        return 'https://' + ACCOUNT_ID + '.app.netsuite.com/app/site/hosting/scriptlet.nl' +
            '?script=' + CYCLE_COUNT_SCRIPT_ID + '&deploy=' + CYCLE_COUNT_DEPLOY_ID;
    }

    // ------------------------------------------------------------------
    // Message templates - plain language, no raw NetSuite field errors
    // ------------------------------------------------------------------
    function binNotFoundMessage(binName) {
        return '"' + binName + '" was NOT FOUND at this location. Check the Bin List to confirm: ' +
            buildBinListLink(binName) + '. If the Bin/LP genuinely does not exist, kick off a cycle ' +
            'count here: ' + buildCycleCountLink() + '.';
    }

    function binInactiveMessage(binName) {
        return '"' + binName + '" exists but is INACTIVE at this location. To reactivate: open the ' +
            'Bin/LP record, click Edit, uncheck the Inactive box, and save. View it in the Bin List: ' +
            buildBinListLink(binName) + '.';
    }

    function lotNotFoundMessage(lotName) {
        return '"' + lotName + '" (Lot/Serial Number) was NOT FOUND for this item. Confirm the lot ' +
            'number is correct, or if it should exist, kick off a cycle count: ' + buildCycleCountLink() + '.';
    }

    function noInventoryMessage(binName, lotName) {
        return 'No on-hand inventory was found for this item in Bin/LP "' + (binName || '(none)') +
            '" / Lot "' + (lotName || '(none)') + '". Check the Bin List: ' + buildBinListLink(binName) +
            ', or kick off a cycle count if this combination should have stock: ' + buildCycleCountLink() + '.';
    }

    function insufficientQtyMessage(available, reserved, requested, binName, lotName) {
        var msg = 'Only ' + available + ' unit(s) available for this item';
        if (binName) { msg += ' in Bin/LP "' + binName + '"'; }
        if (lotName) { msg += ' / Lot "' + lotName + '"'; }
        if (reserved > 0) {
            msg += ' (' + reserved + ' already reserved by other open IA Requests)';
        }
        msg += '. This line requests ' + Math.abs(requested) + ' unit(s). Reduce the quantity, pick a ' +
            'different Bin/LP or Lot, or kick off a cycle count if the on-hand count looks wrong: ' +
            buildCycleCountLink() + '.';
        return msg;
    }

    // ------------------------------------------------------------------
    // isBypassRole - true when the record is being saved by someone
    // holding the recall-only Inventory Adjustment Role.
    // ------------------------------------------------------------------
    function isBypassRole() {
        try {
            var currentUser = runtime.getCurrentUser();
            return !!currentUser && Number(currentUser.role) === BYPASS_ROLE_ID;
        } catch (e) {
            log.error('isBypassRole failed', e.message);
            return false;
        }
    }

    // ------------------------------------------------------------------
    // createNextReturnBin - mints the next S#### return LP, creates the
    // real Bin record for it (flagged "Sam's Return Bin"), and returns
    // its name. Locked so two lines saved back-to-back can't land on the
    // same number.
    // ------------------------------------------------------------------
    function createNextReturnBin() {
        var scriptLock = lock.acquireLock({ key: LP_COUNTER_LOCK_KEY, timeout: 15 });
        try {
            var sql =
                "SELECT MAX(TO_NUMBER(SUBSTR(binnumber, 2))) AS maxnum FROM bin " +
                "WHERE custrecord_sams_return_bin = 'T' AND REGEXP_LIKE(binnumber, '^" + LP_PREFIX + "[0-9]+$')";
            var results = query.runSuiteQL({ query: sql }).asMappedResults();
            var maxNum = (results.length > 0 && results[0].maxnum !== null && results[0].maxnum !== undefined)
                ? parseInt(results[0].maxnum, 10) : (LP_START_NUMBER - 1);
            var nextNum = Math.max(maxNum + 1, LP_START_NUMBER);
            var binName = LP_PREFIX + nextNum;

            var binRecord = record.create({ type: 'bin', isDynamic: false });
            binRecord.setValue({ fieldId: 'binnumber', value: binName });
            binRecord.setValue({ fieldId: 'location', value: BYPASS_LOCATION_ID });
            binRecord.setValue({ fieldId: 'custrecord_sams_return_bin', value: true });
            binRecord.save();

            return binName;
        } catch (e) {
            log.error('createNextReturnBin failed', e.message);
            throw new Error('Could not create the next return LP: ' + e.message);
        } finally {
            scriptLock.release();
        }
    }

    // ------------------------------------------------------------------
    // classifyBin - single (location, binName) lookup.
    // Returns 'ok' | 'inactive' | 'not_found'
    // ------------------------------------------------------------------
    function classifyBin(locationId, binName) {
        try {
            var sql = 'SELECT isinactive FROM bin WHERE binnumber = ? AND location = ?';
            var results = query.runSuiteQL({ query: sql, params: [binName, locationId] }).asMappedResults();
            if (results.length === 0) { return 'not_found'; }
            return (results[0].isinactive === 'T' || results[0].isinactive === true) ? 'inactive' : 'ok';
        } catch (e) {
            log.error('classifyBin failed', 'Bin "' + binName + '" at location ' + locationId + ': ' + e.message);
            throw e;
        }
    }

    // ------------------------------------------------------------------
    // lotExists - single (item, lotName) lookup.
    // ------------------------------------------------------------------
    function lotExists(itemId, lotName) {
        try {
            var sql = 'SELECT id FROM inventorynumber WHERE item = ? AND inventorynumber = ?';
            var results = query.runSuiteQL({ query: sql, params: [itemId, lotName] }).asMappedResults();
            return results.length > 0;
        } catch (e) {
            log.error('lotExists failed', 'Item ' + itemId + ' lot "' + lotName + '": ' + e.message);
            throw e;
        }
    }

    // ------------------------------------------------------------------
    // getLiveAvailable - live on-hand/available quantity from
    // InventoryBalance for the exact item/location/bin/lot combo.
    // Returns a number, or null if no balance row exists for that combo.
    // ------------------------------------------------------------------
    function getLiveAvailable(itemId, locationId, binName, lotName) {
        try {
            var sql =
                'SELECT SUM(ib.quantityavailable) AS availableqty ' +
                'FROM inventorybalance ib ' +
                'LEFT JOIN bin b ON b.id = ib.binnumber ' +
                'LEFT JOIN inventorynumber inv ON inv.id = ib.inventorynumber ' +
                'WHERE ib.item = ? AND ib.location = ? ' +
                'AND NVL(b.binnumber, \'\') = ? AND NVL(inv.inventorynumber, \'\') = ?';
            var results = query.runSuiteQL({
                query: sql,
                params: [itemId, locationId, binName || '', lotName || '']
            }).asMappedResults();
            if (results.length === 0 || results[0].availableqty === null || results[0].availableqty === undefined) {
                return null;
            }
            return parseFloat(results[0].availableqty) || 0;
        } catch (e) {
            log.error('getLiveAvailable failed', 'Item ' + itemId + ' loc ' + locationId + ': ' + e.message);
            throw e;
        }
    }

    // ------------------------------------------------------------------
    // getReservedByOthers - quantity already claimed by OTHER still-open
    // IA Requests against the same item/location/bin/lot combo, so two
    // requests can't both draw against the same units before either posts.
    // ------------------------------------------------------------------
    function getReservedByOthers(itemId, locationId, binName, lotName, excludeRequestId) {
        if (!excludeRequestId) { return 0; }
        try {
            var sql =
                'SELECT SUM(CASE WHEN l.custrecord_adjust_qty_by < 0 THEN ABS(l.custrecord_adjust_qty_by) ELSE 0 END) AS reservedqty ' +
                'FROM customrecord_ia_request_lines l ' +
                'JOIN customrecord_inventory_adjustment_reques h ON h.id = l.custrecord_ia_request ' +
                'WHERE h.custrecord_approval_status NOT IN (?, ?) ' + // exclude Finance Approved / Rejected
                'AND l.custrecord_ia_request != ? ' +                // exclude the request being checked
                'AND l.custrecord_item = ? AND l.custrecord_location = ? ' +
                'AND NVL(l.custrecord_binlp_number, \'\') = ? AND NVL(l.custrecord_lot_number, \'\') = ?';
            var params = [STATUS_FINANCE_APPROVED, STATUS_REJECTED, excludeRequestId,
                itemId, locationId, binName || '', lotName || ''];
            var results = query.runSuiteQL({ query: sql, params: params }).asMappedResults();
            if (results.length === 0 || results[0].reservedqty === null) { return 0; }
            return parseFloat(results[0].reservedqty) || 0;
        } catch (e) {
            log.error('getReservedByOthers failed', 'Item ' + itemId + ' loc ' + locationId + ': ' + e.message);
            throw e;
        }
    }

    // ------------------------------------------------------------------
    // validateLine - runs all checks for one item/location/bin/lot/qty
    // combo. Returns { problems: [...], trueAvailable: number|null }
    // ------------------------------------------------------------------
    function validateLine(itemId, locationId, binName, lotName, qty, requestId) {
        var problems = [];
        var trueAvailable = null;
        qty = parseFloat(qty) || 0;

        var binStatus = null;
        if (binName) {
            binStatus = classifyBin(locationId, binName);
            if (binStatus === 'not_found') {
                problems.push(binNotFoundMessage(binName));
            } else if (binStatus === 'inactive') {
                problems.push(binInactiveMessage(binName));
            }
        }

        var lotOk = true;
        if (lotName) {
            lotOk = lotExists(itemId, lotName);
            if (!lotOk) {
                problems.push(lotNotFoundMessage(lotName));
            }
        }

        // Only run the quantity-available check if bin/lot themselves
        // checked out OK (or weren't provided) - no point stacking a
        // confusing "insufficient qty" message on top of a bad bin.
        var binOk = !binName || binStatus === 'ok';
        if (binOk && lotOk) {
            var liveAvailable = getLiveAvailable(itemId, locationId, binName, lotName);
            if (liveAvailable === null) {
                if (binName || lotName) {
                    problems.push(noInventoryMessage(binName, lotName));
                }
            } else {
                var reserved = getReservedByOthers(itemId, locationId, binName, lotName, requestId);
                trueAvailable = liveAvailable - reserved;
                if (qty < 0 && Math.abs(qty) > trueAvailable) {
                    problems.push(insufficientQtyMessage(trueAvailable, reserved, qty, binName, lotName));
                }
            }
        }

        return { problems: problems, trueAvailable: trueAvailable };
    }

    // ------------------------------------------------------------------
    // beforeSubmit
    // ------------------------------------------------------------------
    function beforeSubmit(scriptContext) {
        var t = scriptContext.type;
        if (t !== scriptContext.UserEventType.CREATE &&
            t !== scriptContext.UserEventType.EDIT &&
            t !== scriptContext.UserEventType.XEDIT) {
            return;
        }
        var rec = scriptContext.newRecord;

        var itemId    = rec.getValue({ fieldId: 'custrecord_item' });
        var binName   = rec.getValue({ fieldId: 'custrecord_binlp_number' });
        var lotName   = rec.getValue({ fieldId: 'custrecord_lot_number' });
        var lineLoc   = rec.getValue({ fieldId: 'custrecord_location' });
        var parentId  = rec.getValue({ fieldId: 'custrecord_ia_request' });
        var qty       = rec.getValue({ fieldId: 'custrecord_adjust_qty_by' });

        // Inline edit (XEDIT) only carries changed fields - backfill from
        // the existing record so partial edits still validate correctly.
        if (t === scriptContext.UserEventType.XEDIT && rec.id) {
            var existing;
            try {
                existing = search.lookupFields({
                    type:    'customrecord_ia_request_lines',
                    id:      rec.id,
                    columns: ['custrecord_item', 'custrecord_binlp_number', 'custrecord_lot_number',
                              'custrecord_location', 'custrecord_ia_request', 'custrecord_adjust_qty_by']
                });
            } catch (e) {
                log.error('XEDIT backfill lookup failed', 'Line ' + rec.id + ': ' + e.message);
                throw new Error('Could not validate this line - backfill lookup failed: ' + e.message);
            }
            if (!itemId && existing.custrecord_item && existing.custrecord_item.length > 0) {
                itemId = existing.custrecord_item[0].value;
            }
            if (!binName) { binName = existing.custrecord_binlp_number; }
            if (!lotName) { lotName = existing.custrecord_lot_number; }
            if (!lineLoc && existing.custrecord_location && existing.custrecord_location.length > 0) {
                lineLoc = existing.custrecord_location[0].value;
            }
            if (!parentId && existing.custrecord_ia_request && existing.custrecord_ia_request.length > 0) {
                parentId = existing.custrecord_ia_request[0].value;
            }
            if (qty === '' || qty === null) { qty = existing.custrecord_adjust_qty_by; }
        }

        // ------------------------------------------------------------
        // RECALL BYPASS - [Seviroli] - Inventory Adjustment Role
        // Item/location are forced regardless of what was submitted, a
        // new S#### return LP is minted the first time the line is
        // saved if one isn't already assigned, and none of the normal
        // Bin/Lot/quantity-available checks below apply - this is a
        // brand-new, empty LP receiving a positive recall return.
        // ------------------------------------------------------------
        if (isBypassRole()) {
            rec.setValue({ fieldId: 'custrecord_item', value: BYPASS_ITEM_ID });
            rec.setValue({ fieldId: 'custrecord_location', value: BYPASS_LOCATION_ID });

            var bypassQty = parseFloat(qty) || 0;
            if (bypassQty <= 0) {
                throw new Error('Enter a quantity greater than zero for this recall return line.');
            }

            if (!binName) {
                binName = createNextReturnBin();
                rec.setValue({ fieldId: 'custrecord_binlp_number', value: binName });
            }

            rec.setValue({ fieldId: 'custrecord_sev_current_on_hand_available', value: 0 });
            return;
        }

        // Fall back to the parent header location if the line location is blank
        if (!lineLoc && parentId) {
            try {
                var parentFields = search.lookupFields({
                    type:    'customrecord_inventory_adjustment_reques',
                    id:      parentId,
                    columns: ['custrecord_adjustment_location']
                });
                if (parentFields.custrecord_adjustment_location &&
                    parentFields.custrecord_adjustment_location.length > 0) {
                    lineLoc = parentFields.custrecord_adjustment_location[0].value;
                }
            } catch (e) {
                log.error('Parent location lookup failed', 'Request ' + parentId + ': ' + e.message);
                throw new Error('Could not validate this line - parent location lookup failed: ' + e.message);
            }
        }

        // Nothing to check yet (no item, or no bin/lot entered and no
        // location to validate a plain quantity against)
        if (!itemId || (!binName && !lotName && !lineLoc)) {
            return;
        }

        var result;
        try {
            result = validateLine(itemId, lineLoc, binName, lotName, qty, parentId);
        } catch (e) {
            log.error('validateLine failed', 'Line ' + (rec.id || '(new)') + ': ' + e.message);
            throw new Error('Could not validate this line - validation lookup failed: ' + e.message);
        }

        // Show what's actually available to write off, right on the line,
        // regardless of whether validation passed or failed.
        if (result.trueAvailable !== null) {
            rec.setValue({ fieldId: 'custrecord_sev_current_on_hand_available', value: Math.max(result.trueAvailable, 0) });
        }

        if (result.problems.length > 0) {
            throw new Error(result.problems.join(' | '));
        }
    }

    return {
        beforeSubmit: beforeSubmit
    };
});