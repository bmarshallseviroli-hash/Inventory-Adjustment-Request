/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * ia_request_approval.js
 * User Event on the IA Request header (customrecord_inventory_adjustment_reques).
 * Deployed in NetSuite as customscript_ia_creation / File Cabinet name "IA Creation.js".
 *
 * Approval workflow gates + Inventory Adjustment creation. Bin/LP/Lot/
 * quantity validation now runs at BOTH the Manager approval step and
 * the Finance approval step against live InventoryBalance data, so
 * problems get caught before Finance ever sees them - and if something
 * slips through or changes between the two approvals, Finance's
 * approval bounces the request back to Pending Manager instead of
 * failing silently.
 *
 * Recall support: users holding the [Seviroli] - Inventory Adjustment
 * Role (internal id 1695, ROLES.RECALL_BYPASS below) skip the Manager/
 * Finance workflow entirely (see the IA Request Approvals workflow) and
 * their request is CREATED already Finance Approved. Since there's no
 * oldRecord to compare against on a CREATE, afterSubmit treats a
 * bypass-role CREATE landing on Finance Approved as the transition-in
 * itself and calls the exact same createInventoryAdjustment() the
 * normal Finance-approval EDIT path uses - scoped to that one role so
 * a CREATE that lands on status 4 any other way doesn't silently post
 * a real adjustment.
 *
 * Self-contained - no external library file. All Bin/Lot/quantity
 * logic below is duplicated in ia_line_validation.js on purpose, so
 * either script can be updated in place (paste new code into the
 * existing Script record) without managing a separate shared file.
 * If the validation logic changes, update BOTH files.
 */
define(['N/record', 'N/search', 'N/runtime', 'N/email', 'N/query', 'N/log'],
    function (record, search, runtime, email, query, log) {

    var ROLES = {
        PRODUCTION_MANAGER: 1516,
        QA_ADMIN:           1561,
        INVENTORY_MANAGER:  1677,
        CONTROLLER:         1512,
        CFO:                1510,
        ADMINISTRATOR:      3,   // NetSuite built-in Administrator role
        RECALL_BYPASS:       1695 // [Seviroli] - Inventory Adjustment Role - not an approval-stage role, see header comment
    };

    // custrecord_approval_status values on customrecord_inventory_adjustment_reques
    var STATUS_PENDING_MANAGER  = 1; // Awaiting Production Manager / QA Admin / Inventory Manager approval
    var STATUS_MANAGER_APPROVED = 6; // Manager approved - awaiting Finance (Controller/CFO) approval
    var STATUS_FINANCE_APPROVED = 4; // Finance approved - triggers Inventory Adjustment creation
    var STATUS_REJECTED         = 7; // Rejected - no Inventory Adjustment created

    // NetSuite account ID, used to build Bin List / Cycle Count links
    // that get dropped into validation-failure emails.
    var ACCOUNT_ID = '682633';

    // Suitelet that starts a cycle count. Script 4889 / Deploy 1 is the
    // "Start Cycle Count" entry point Brad provided - no bin/item
    // pre-fill parameters are exposed by this deployment.
    var CYCLE_COUNT_SCRIPT_ID = '4889';
    var CYCLE_COUNT_DEPLOY_ID = '1';

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
    // placeholders / dedupe - small helpers for building bulk IN clauses
    // ------------------------------------------------------------------
    function placeholders(count) {
        var arr = [];
        for (var i = 0; i < count; i++) { arr.push('?'); }
        return arr.join(',');
    }

    function dedupe(arr) {
        var seen = {};
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            var v = arr[i];
            if (v === null || v === undefined || v === '') { continue; }
            if (!seen[v]) {
                seen[v] = true;
                out.push(v);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------
    // getLinesForRequest - all lines for a request in ONE query.
    // ------------------------------------------------------------------
    function getLinesForRequest(requestId) {
        try {
            var sql =
                'SELECT id, custrecord_line_number AS linenumber, custrecord_item AS item, ' +
                'custrecord_location AS location, custrecord_binlp_number AS binname, ' +
                'custrecord_lot_number AS lotname, custrecord_adjust_qty_by AS qty ' +
                'FROM customrecord_ia_request_lines ' +
                'WHERE custrecord_ia_request = ? ' +
                'ORDER BY custrecord_line_number ASC';
            return query.runSuiteQL({ query: sql, params: [requestId] }).asMappedResults();
        } catch (e) {
            log.error('getLinesForRequest failed', 'Request ' + requestId + ': ' + e.message);
            throw e;
        }
    }

    // ------------------------------------------------------------------
    // classifyBins - ONE query for every distinct (location, binName) pair
    // used across the lines being checked.
    // Returns lookup keyed by "location|binName" -> 'ok' | 'inactive' | 'not_found'
    // ------------------------------------------------------------------
    function classifyBins(locationIds, binNames) {
        var lookup = {};
        var locs = dedupe(locationIds);
        var bins = dedupe(binNames);
        if (locs.length === 0 || bins.length === 0) { return lookup; }
        try {
            var sql =
                'SELECT binnumber, location, isinactive ' +
                'FROM bin ' +
                'WHERE binnumber IN (' + placeholders(bins.length) + ') ' +
                'AND location IN (' + placeholders(locs.length) + ')';
            var results = query.runSuiteQL({ query: sql, params: bins.concat(locs) }).asMappedResults();
            var found = {};
            results.forEach(function (r) {
                found[r.location + '|' + r.binnumber] = (r.isinactive === 'T' || r.isinactive === true) ? 'inactive' : 'ok';
            });
            locs.forEach(function () {}); // no-op, keeps lint quiet on unused var patterns
            bins.forEach(function (bn) {
                locs.forEach(function (loc) {
                    var key = loc + '|' + bn;
                    if (found[key]) { lookup[key] = found[key]; }
                });
            });
        } catch (e) {
            log.error('classifyBins failed', e.message);
            throw e;
        }
        return lookup;
    }

    // ------------------------------------------------------------------
    // classifyLots - ONE query for every distinct (item, lotName) pair.
    // Returns lookup keyed by "item|lotName" -> true (exists)
    // ------------------------------------------------------------------
    function classifyLots(itemIds, lotNames) {
        var lookup = {};
        var items = dedupe(itemIds);
        var lots = dedupe(lotNames);
        if (items.length === 0 || lots.length === 0) { return lookup; }
        try {
            var sql =
                'SELECT item, inventorynumber ' +
                'FROM inventorynumber ' +
                'WHERE item IN (' + placeholders(items.length) + ') ' +
                'AND inventorynumber IN (' + placeholders(lots.length) + ')';
            var results = query.runSuiteQL({ query: sql, params: items.concat(lots) }).asMappedResults();
            results.forEach(function (r) {
                lookup[r.item + '|' + r.inventorynumber] = true;
            });
        } catch (e) {
            log.error('classifyLots failed', e.message);
            throw e;
        }
        return lookup;
    }

    // ------------------------------------------------------------------
    // getAvailability - ONE query pulling live on-hand/available quantity
    // from InventoryBalance for every distinct (item, location) pair used.
    // Returns lookup keyed by "item|location|binName|lotName" -> availableQty
    // ------------------------------------------------------------------
    function getAvailability(itemIds, locationIds) {
        var lookup = {};
        var items = dedupe(itemIds);
        var locs = dedupe(locationIds);
        if (items.length === 0 || locs.length === 0) { return lookup; }
        try {
            var sql =
                'SELECT ib.item AS item, ib.location AS location, b.binnumber AS binname, ' +
                'inv.inventorynumber AS lotname, SUM(ib.quantityavailable) AS availableqty ' +
                'FROM inventorybalance ib ' +
                'LEFT JOIN bin b ON b.id = ib.binnumber ' +
                'LEFT JOIN inventorynumber inv ON inv.id = ib.inventorynumber ' +
                'WHERE ib.item IN (' + placeholders(items.length) + ') ' +
                'AND ib.location IN (' + placeholders(locs.length) + ') ' +
                'GROUP BY ib.item, ib.location, b.binnumber, inv.inventorynumber';
            var results = query.runSuiteQL({ query: sql, params: items.concat(locs) }).asMappedResults();
            results.forEach(function (r) {
                var key = r.item + '|' + r.location + '|' + (r.binname || '') + '|' + (r.lotname || '');
                lookup[key] = parseFloat(r.availableqty) || 0;
            });
        } catch (e) {
            log.error('getAvailability failed', e.message);
            throw e;
        }
        return lookup;
    }

    // ------------------------------------------------------------------
    // getReservedByOthers - ONE query summing write-down quantity already
    // claimed by OTHER still-open IA Requests against the same
    // item/location/bin/lot combos, so two requests can't both draw
    // against the same units before either one posts.
    // Returns lookup keyed by "item|location|binName|lotName" -> reservedQty
    // ------------------------------------------------------------------
    function getReservedByOthers(itemIds, locationIds, excludeRequestId) {
        var lookup = {};
        var items = dedupe(itemIds);
        var locs = dedupe(locationIds);
        if (items.length === 0 || locs.length === 0) { return lookup; }
        try {
            var sql =
                'SELECT l.custrecord_item AS item, l.custrecord_location AS location, ' +
                'l.custrecord_binlp_number AS binname, l.custrecord_lot_number AS lotname, ' +
                'SUM(CASE WHEN l.custrecord_adjust_qty_by < 0 THEN ABS(l.custrecord_adjust_qty_by) ELSE 0 END) AS reservedqty ' +
                'FROM customrecord_ia_request_lines l ' +
                'JOIN customrecord_inventory_adjustment_reques h ON h.id = l.custrecord_ia_request ' +
                'WHERE h.custrecord_approval_status NOT IN (?, ?) ' + // exclude Finance Approved / Rejected
                'AND l.custrecord_ia_request != ? ' +                // exclude the request being checked
                'AND l.custrecord_item IN (' + placeholders(items.length) + ') ' +
                'AND l.custrecord_location IN (' + placeholders(locs.length) + ') ' +
                'GROUP BY l.custrecord_item, l.custrecord_location, l.custrecord_binlp_number, l.custrecord_lot_number';
            var params = [STATUS_FINANCE_APPROVED, STATUS_REJECTED, excludeRequestId].concat(items).concat(locs);
            var results = query.runSuiteQL({ query: sql, params: params }).asMappedResults();
            results.forEach(function (r) {
                var key = r.item + '|' + r.location + '|' + (r.binname || '') + '|' + (r.lotname || '');
                lookup[key] = parseFloat(r.reservedqty) || 0;
            });
        } catch (e) {
            log.error('getReservedByOthers failed', e.message);
            throw e;
        }
        return lookup;
    }

    // ------------------------------------------------------------------
    // evaluateLine - runs all checks for a single line against
    // pre-fetched lookups. Returns { problems: [...], trueAvailable: number|null }
    // ------------------------------------------------------------------
    function evaluateLine(line, binLookup, lotLookup, availLookup, reservedLookup) {
        var problems = [];
        var item = line.item;
        var location = line.location;
        var binName = line.binname;
        var lotName = line.lotname;
        var qty = parseFloat(line.qty) || 0;
        var trueAvailable = null;

        if (binName) {
            var binStatus = binLookup[location + '|' + binName];
            if (binStatus === 'not_found' || !binStatus) {
                problems.push(binNotFoundMessage(binName));
            } else if (binStatus === 'inactive') {
                problems.push(binInactiveMessage(binName));
            }
        }

        if (lotName) {
            var lotKey = item + '|' + lotName;
            if (!lotLookup[lotKey]) {
                problems.push(lotNotFoundMessage(lotName));
            }
        }

        var binOk = !binName || binLookup[location + '|' + binName] === 'ok';
        var lotOk = !lotName || lotLookup[item + '|' + lotName];
        if (binOk && lotOk) {
            var availKey = item + '|' + location + '|' + (binName || '') + '|' + (lotName || '');
            var liveAvailable = Object.prototype.hasOwnProperty.call(availLookup, availKey) ? availLookup[availKey] : null;
            var reserved = reservedLookup[availKey] || 0;

            if (liveAvailable === null) {
                if (binName || lotName) {
                    problems.push(noInventoryMessage(binName, lotName));
                }
            } else {
                trueAvailable = liveAvailable - reserved;
                if (qty < 0 && Math.abs(qty) > trueAvailable) {
                    problems.push(insufficientQtyMessage(trueAvailable, reserved, qty, binName, lotName));
                }
            }
        }

        return { problems: problems, trueAvailable: trueAvailable };
    }

    // ------------------------------------------------------------------
    // validateRequestLines - bulk entry point used at Manager and Finance
    // approval transitions. Runs a fixed number of queries (5) no matter
    // how many lines the request has.
    // ------------------------------------------------------------------
    function validateRequestLines(requestId) {
        var lines = getLinesForRequest(requestId);
        var itemIds = [];
        var locationIds = [];
        var binNames = [];
        var lotNames = [];

        lines.forEach(function (l) {
            if (l.item) { itemIds.push(l.item); }
            if (l.location) { locationIds.push(l.location); }
            if (l.binname) { binNames.push(l.binname); }
            if (l.lotname) { lotNames.push(l.lotname); }
        });

        var binLookup = classifyBins(locationIds, binNames);
        var lotLookup = classifyLots(itemIds, lotNames);
        var availLookup = getAvailability(itemIds, locationIds);
        var reservedLookup = getReservedByOthers(itemIds, locationIds, requestId);

        var lineResults = [];
        var hasProblems = false;

        lines.forEach(function (l) {
            if (!l.item) { return; } // blank/placeholder line - nothing to check
            var evalResult = evaluateLine(l, binLookup, lotLookup, availLookup, reservedLookup);
            if (evalResult.problems.length > 0) { hasProblems = true; }
            lineResults.push({
                lineId: l.id,
                lineNumber: l.linenumber,
                problems: evalResult.problems,
                trueAvailable: evalResult.trueAvailable
            });
        });

        return { hasProblems: hasProblems, lineResults: lineResults };
    }

    // ------------------------------------------------------------------
    // formatProblemsForEmail - turns lineResults into an HTML block for
    // the bounce-back / approval-blocked emails.
    // ------------------------------------------------------------------
    function formatProblemsForEmail(lineResults) {
        var out = [];
        lineResults.forEach(function (lr) {
            if (lr.problems.length > 0) {
                out.push('<b>Line ' + lr.lineNumber + ':</b><br>' + lr.problems.join('<br>'));
            }
        });
        return out.join('<br><br>');
    }

    // ------------------------------------------------------------------
    // safeValidate - wraps validateRequestLines with try/catch so a
    // lookup failure reads as a clear error instead of a raw stack trace.
    // ------------------------------------------------------------------
    function safeValidate(requestId) {
        try {
            return validateRequestLines(requestId);
        } catch (e) {
            log.error('safeValidate failed', 'Request ' + requestId + ': ' + e.message);
            throw new Error('Could not validate this request - Bin/LP/Lot lookup failed: ' + e.message);
        }
    }

    // ------------------------------------------------------------------
    // runValidationOrThrow - used by the plain-edit / location-change path,
    // where there's no workflow status transition to manage, just a
    // straightforward block-with-message.
    // ------------------------------------------------------------------
    function runValidationOrThrow(requestId, headerMessage) {
        var check = safeValidate(requestId);
        if (check.hasProblems) {
            throw new Error(headerMessage + ': ' + formatProblemsForEmail(check.lineResults).replace(/<br>/g, ' '));
        }
    }

    // ------------------------------------------------------------------
    // bounceBackToManager - resets status to Pending Manager (separate,
    // already-committed operation, distinct from the current save that's
    // about to be thrown/rolled back) and emails requester + manager
    // approver with the specific Bin/LP/Lot/quantity problems found.
    // ------------------------------------------------------------------
    function bounceBackToManager(rec, checkResult, currentUser) {
        var requestId = rec.id;
        var requestName = rec.getValue({ fieldId: 'name' }) || ('#' + requestId);
        try {
            record.submitFields({
                type:   'customrecord_inventory_adjustment_reques',
                id:     requestId,
                values: { custrecord_approval_status: STATUS_PENDING_MANAGER }
            });
            log.audit('Request bounced at Finance stage', 'Request ' + requestId +
                ' sent back to Pending Manager Approval - Bin/LP/Lot/quantity problems found.');
        } catch (resetErr) {
            log.error('Finance-stage bounce-back FAILED', 'Could not reset request ' + requestId +
                ' to Pending Manager: ' + resetErr.message + ' - manual correction may be required.');
        }
        try {
            var recips = [];
            var reqBy  = rec.getValue({ fieldId: 'custrecord_requested_by' });
            var mgrBy  = rec.getValue({ fieldId: 'custrecord_manager_appover' });
            if (reqBy) { recips.push(reqBy); }
            if (mgrBy && mgrBy !== reqBy) { recips.push(mgrBy); }
            if (recips.length === 0) {
                log.error('Finance bounce-back email skipped', 'No recipients on request ' + requestId);
                return;
            }
            email.send({
                author:     currentUser.id,
                recipients: recips,
                subject:    'IA Request Returned to Manager - Bin/LP/Lot Problems: ' + requestName,
                body:       'Inventory adjustment request "' + requestName + '" was sent back to you for ' +
                            'correction. Finance tried to approve it, but the following problems were found ' +
                            'first:<br><br>' + formatProblemsForEmail(checkResult.lineResults) + '<br><br>' +
                            'Correct the lines above, then re-route the request through Manager approval.<br><br>' +
                            'This is an automated notification.'
            });
        } catch (mailErr) {
            log.error('Finance bounce-back email failed', mailErr.message);
        }
    }

    // ------------------------------------------------------------------
    // beforeSubmit
    // ------------------------------------------------------------------
    function beforeSubmit(scriptContext) {
        var currentUser = runtime.getCurrentUser();
        var rec = scriptContext.newRecord;
        // Requested By is stamped by the workflow (Pending Manager Approval state, on Entry)
        if (scriptContext.type !== scriptContext.UserEventType.EDIT) {
            return;
        }
        var currentRole = currentUser.role;
        var oldRec      = scriptContext.oldRecord;
        var newStatus = rec.getValue({ fieldId: 'custrecord_approval_status' });
        var oldStatus = oldRec.getValue({ fieldId: 'custrecord_approval_status' });

        // If the header location changed on a normal edit (no status change),
        // re-validate all line bins/lots/quantities against the new location.
        // Safe to throw here - no workflow button is involved in a plain edit save.
        var newLoc = rec.getValue({ fieldId: 'custrecord_adjustment_location' });
        var oldLoc = oldRec.getValue({ fieldId: 'custrecord_adjustment_location' });
        if (newStatus === oldStatus && newLoc !== oldLoc && newStatus == STATUS_PENDING_MANAGER) {
            runValidationOrThrow(rec.id, 'Bin/LP, Lot, or quantity problems found after location change');
        }

        if (newStatus === oldStatus) {
            return;
        }

        // Manager-stage approval: only Production Manager, QA Admin,
        // Inventory Manager, or Administrator may approve or reject at this stage
        if (oldStatus == STATUS_PENDING_MANAGER && (newStatus == STATUS_MANAGER_APPROVED || newStatus == STATUS_REJECTED)) {
            var isManagerRole = (currentRole === ROLES.PRODUCTION_MANAGER ||
                                 currentRole === ROLES.QA_ADMIN ||
                                 currentRole === ROLES.INVENTORY_MANAGER ||
                                 currentRole === ROLES.ADMINISTRATOR);
            if (!isManagerRole) {
                throw new Error('Only a Production Manager, QA Admin, or Inventory Manager can approve or reject at this stage.');
            }
        }

        // Bin/Lot/quantity validation at MANAGER approval. If any line has a
        // problem, email the approver (guaranteed visibility) and block the
        // approval outright - status never leaves Pending Manager since the
        // throw aborts this save.
        if (oldStatus == STATUS_PENDING_MANAGER && newStatus == STATUS_MANAGER_APPROVED) {
            var managerCheck = safeValidate(rec.id);
            if (managerCheck.hasProblems) {
                var requestName = rec.getValue({ fieldId: 'name' }) || ('#' + rec.id);
                try {
                    email.send({
                        author:     currentUser.id,
                        recipients: [currentUser.id],
                        subject:    'IA Request Approval Blocked: ' + requestName,
                        body:       'Your approval of inventory adjustment request "' + requestName +
                                    '" was blocked.<br><br>' +
                                    formatProblemsForEmail(managerCheck.lineResults) + '<br><br>' +
                                    'Please correct the lines above, then approve the request again.<br><br>' +
                                    'This is an automated notification.'
                    });
                } catch (mailErr) {
                    log.error('Approval-block email failed', mailErr.message);
                }
                throw new Error('Approval blocked - Bin/LP/Lot/quantity problems found. An email with ' +
                    'details has been sent to you. Correct the lines and approve again.');
            }
            // Stamp Manager Approver when the manager approves
            rec.setValue({
                fieldId: 'custrecord_manager_appover',
                value:   currentUser.id
            });
        }

        log.debug('Status change', 'From: ' + oldStatus + ' To: ' + newStatus);

        var isFinanceRole = (currentRole === ROLES.CONTROLLER ||
                             currentRole === ROLES.CFO ||
                             currentRole === ROLES.ADMINISTRATOR);

        if (newStatus == STATUS_FINANCE_APPROVED) {
            if (!isFinanceRole) {
                throw new Error('Only the Controller or CFO can approve at this stage.');
            }

            // Safety-net validation at FINANCE approval. Inventory can shift
            // between Manager approval and Finance approval, so re-check
            // here too. If something is wrong, don't just block in place -
            // bounce the request back to Pending Manager (submitFields,
            // which persists even though this save is about to be thrown)
            // and email the requester + manager approver.
            var financeCheck = safeValidate(rec.id);
            if (financeCheck.hasProblems) {
                bounceBackToManager(rec, financeCheck, currentUser);
                throw new Error('This request has Bin/LP/Lot/quantity problems and was sent back to ' +
                    'Pending Manager Approval. An email with details was sent to the requester and manager approver.');
            }

            rec.setValue({
                fieldId: 'custrecord_finance_approver',
                value:   currentUser.id
            });
        }
    }

    // ------------------------------------------------------------------
    // createInventoryAdjustment - builds and posts the real Inventory
    // Adjustment for an already-Finance-Approved request, and stamps
    // custrecord_linked_ia back onto the header. Called from afterSubmit
    // by both the normal EDIT-transition path and the recall-bypass
    // CREATE path - same logic either way, no duplication.
    // ------------------------------------------------------------------
    function createInventoryAdjustment(iaRequestId) {
        log.audit('IA Creation Triggered', 'Request: ' + iaRequestId);
        try {
            var iaRequestRec = record.load({
                type: 'customrecord_inventory_adjustment_reques',
                id:   iaRequestId
            });
            var adjDate     = iaRequestRec.getValue({ fieldId: 'custrecord_adjustment_date' });
            var adjLocation = iaRequestRec.getValue({ fieldId: 'custrecord_adjustment_location' });
            var adjReason   = iaRequestRec.getValue({ fieldId: 'custrecord_adjustment_reason' });
            if (!adjLocation || !adjReason) {
                log.error('Missing fields', 'Location or Reason missing on request ' + iaRequestId);
                return;
            }
            var lines = [];
            search.create({
                type: 'customrecord_ia_request_lines',
                filters: [['custrecord_ia_request', 'anyof', iaRequestId]],
                columns: [
                    search.createColumn({ name: 'custrecord_line_number', sort: search.Sort.ASC }),
                    search.createColumn({ name: 'custrecord_item' }),
                    search.createColumn({ name: 'custrecord_description' }),
                    search.createColumn({ name: 'custrecord_adjust_qty_by' }),
                    search.createColumn({ name: 'custrecord_location' }),
                    search.createColumn({ name: 'custrecord_lot_number' }),
                    search.createColumn({ name: 'custrecord_binlp_number' })
                ]
            }).run().each(function (result) {
                lines.push({
                    item:        result.getValue('custrecord_item'),
                    description: result.getValue('custrecord_description'),
                    adjustQty:   parseFloat(result.getValue('custrecord_adjust_qty_by') || 0),
                    location:    result.getValue('custrecord_location') || adjLocation,
                    lotNumber:   result.getValue('custrecord_lot_number'),
                    binNumber:   result.getValue('custrecord_binlp_number')
                });
                return true;
            });
            if (lines.length === 0) {
                log.error('No lines', 'No lines on request ' + iaRequestId);
                return;
            }

            // All inventory adjustments default to Seviroli Foods, LLC
            var SUBSIDIARY_ID = 2;
            var iaRec = record.create({
                type:      record.Type.INVENTORY_ADJUSTMENT,
                isDynamic: true
            });
            // Subsidiary must be set BEFORE location is valid
            iaRec.setValue({ fieldId: 'subsidiary', value: SUBSIDIARY_ID });
            iaRec.setValue({ fieldId: 'adjlocation', value: adjLocation });
            // Set the Atlas reason body field (drives UI display + Atlas workflow)
            iaRec.setValue({ fieldId: 'custbody_atlas_inv_adj_reason', value: adjReason });

            // Reason -> Account mapping: look up the account on the reason record.
            // Actually SET further down, right before save() - enableSourcing:true
            // on save() re-runs field sourcing and was silently re-deriving (blanking)
            // this field regardless of when it was set earlier in the script, so it
            // has to be the very last thing written before the record is posted.
            var reasonAccount = getReasonAccount(adjReason);
            if (!reasonAccount) {
                log.error('No account on reason', 'Reason record ' + adjReason + ' has no account mapped.');
            }

            if (adjDate) {
                iaRec.setValue({ fieldId: 'trandate', value: new Date(adjDate) });
            }
            iaRec.setValue({ fieldId: 'memo', value: 'IA Request #' + iaRequestId });

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (!line.item) {
                    continue;
                }
                iaRec.selectNewLine({ sublistId: 'inventory' });
                iaRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item',        value: parseInt(line.item, 10) });
                iaRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'location',    value: line.location });
                iaRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: line.adjustQty });
                if (line.description) {
                    iaRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'memo', value: line.description });
                }
                var invDetail = iaRec.getCurrentSublistSubrecord({
                    sublistId: 'inventory',
                    fieldId:   'inventorydetail'
                });
                invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                if (line.lotNumber) {
                    invDetail.setCurrentSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId:   'receiptinventorynumber',
                        value:     line.lotNumber
                    });
                }
                if (line.binNumber) {
                    var binId = getBinId(line.binNumber, line.location);
                    if (!binId) {
                        // Abort the entire IA creation - never post a
                        // half-formed adjustment with missing bin detail.
                        // This should be rare now that both approval stages
                        // validate against InventoryBalance first, but stays
                        // as a hard safety net.
                        throw new Error('IA creation aborted: Bin/LP "' + line.binNumber +
                            '" does not exist (or is inactive) at location ' + line.location +
                            ' (line ' + (i + 1) + '). Correct the request line and re-approve.');
                    }
                    invDetail.setCurrentSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId:   'binnumber',
                        value:     binId
                    });
                }
                invDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId:   'quantity',
                    value:     line.adjustQty
                });
                invDetail.commitLine({ sublistId: 'inventoryassignment' });
                iaRec.commitLine({ sublistId: 'inventory' });
            }

            if (reasonAccount) {
                // Dynamic mode needs a number here, not the string search.lookupFields()
                // returns. Set last, immediately before save(), so nothing after this
                // point (including save()'s own sourcing pass) can clear it.
                iaRec.setValue({ fieldId: 'account', value: parseInt(reasonAccount, 10) });
                log.debug('Account sourced from reason', 'Reason: ' + adjReason + ' Account: ' + reasonAccount);
            }

            var newIaId = iaRec.save({
                enableSourcing:        false,
                ignoreMandatoryFields: false
            });
            log.audit('IA Created', 'New IA: ' + newIaId);
            record.submitFields({
                type:   'customrecord_inventory_adjustment_reques',
                id:     iaRequestId,
                values: { custrecord_linked_ia: newIaId }
            });
        } catch (e) {
            log.error('afterSubmit FAILED', e.message);
            // IA creation failed (bad data). Bounce the request back to
            // Pending Manager Approval so the lines can be corrected and
            // re-approved - no manual workflow cancel needed. submitFields
            // is a direct field write; the self-heal Before Record Load
            // transition resyncs the workflow to Pending Manager on next load.
            try {
                record.submitFields({
                    type:   'customrecord_inventory_adjustment_reques',
                    id:     iaRequestId,
                    values: { custrecord_approval_status: STATUS_PENDING_MANAGER }
                });
                log.audit('Request reset', 'Request ' + iaRequestId +
                    ' bounced back to Pending Manager Approval after IA creation failure.');
                // Notify the finance approver + requester so someone acts on it
                try {
                    var failRec  = record.load({
                        type: 'customrecord_inventory_adjustment_reques',
                        id:   iaRequestId
                    });
                    var failName = failRec.getValue({ fieldId: 'name' }) || ('#' + iaRequestId);
                    var recips   = [];
                    var reqBy    = failRec.getValue({ fieldId: 'custrecord_requested_by' });
                    var mgrBy    = failRec.getValue({ fieldId: 'custrecord_manager_appover' });
                    var financer = runtime.getCurrentUser().id;
                    if (reqBy)  { recips.push(reqBy); }
                    if (mgrBy && mgrBy !== reqBy) { recips.push(mgrBy); }
                    if (financer && recips.indexOf(financer) === -1) { recips.push(financer); }
                    if (recips.length > 0) {
                        email.send({
                            author:     financer,
                            recipients: recips,
                            subject:    'IA Request Returned - Adjustment Could Not Be Created: ' + failName,
                            body:       'The inventory adjustment request "' + failName + '" was approved, ' +
                                        'but the adjustment could not be created due to a data problem:<br><br>' +
                                        e.message + '<br><br>' +
                                        'The request has been returned to Pending Manager Approval. ' +
                                        'Please correct the line data and route it through approval again.<br><br>' +
                                        'This is an automated notification.'
                        });
                    }
                } catch (mailErr2) {
                    log.error('Reset notification email failed', mailErr2.message);
                }
            } catch (resetErr) {
                log.error('Request reset FAILED', 'Could not bounce request ' + iaRequestId +
                    ' back to Pending Manager: ' + resetErr.message +
                    ' - manual workflow cancel may be required.');
            }
        }
    }

    // ------------------------------------------------------------------
    // afterSubmit
    // ------------------------------------------------------------------
    function afterSubmit(scriptContext) {
        var t = scriptContext.type;
        var isCreate = (t === scriptContext.UserEventType.CREATE);
        var isEdit   = (t === scriptContext.UserEventType.EDIT);
        if (!isCreate && !isEdit) {
            return;
        }

        var newRec = scriptContext.newRecord;
        var newStatus = newRec.getValue({ fieldId: 'custrecord_approval_status' });

        // Recall bypass - see header comment. No oldRecord exists on
        // CREATE, so a bypass-role CREATE landing on Finance Approved IS
        // the transition-in. Everyone else's CREATE is ignored, same as
        // before this change.
        if (isCreate) {
            var currentUser = runtime.getCurrentUser();
            var isBypassCreate = currentUser && Number(currentUser.role) === ROLES.RECALL_BYPASS &&
                newStatus == STATUS_FINANCE_APPROVED;
            if (!isBypassCreate) {
                return;
            }
            createInventoryAdjustment(newRec.id);
            return;
        }

        var oldRec = scriptContext.oldRecord;
        var oldStatus = oldRec.getValue({ fieldId: 'custrecord_approval_status' });

        // Rejection email - fires when status just changed TO Rejected
        if (newStatus == STATUS_REJECTED && oldStatus != STATUS_REJECTED) {
            sendRejectionEmail(newRec);
            return;
        }

        if (newStatus != STATUS_FINANCE_APPROVED || oldStatus == STATUS_FINANCE_APPROVED) {
            return;
        }

        createInventoryAdjustment(newRec.id);
    }

    // ------------------------------------------------------------------
    // sendRejectionEmail - notifies requester and manager approver
    // ------------------------------------------------------------------
    function sendRejectionEmail(rec) {
        try {
            var requestedBy = rec.getValue({ fieldId: 'custrecord_requested_by' });
            var managerAppr = rec.getValue({ fieldId: 'custrecord_manager_appover' });
            var requestName = rec.getValue({ fieldId: 'name' });
            var recipients = [];
            if (requestedBy) { recipients.push(requestedBy); }
            if (managerAppr && managerAppr !== requestedBy) { recipients.push(managerAppr); }
            if (recipients.length === 0) {
                log.error('Rejection email skipped', 'No recipients on request ' + rec.id);
                return;
            }
            email.send({
                author:     runtime.getCurrentUser().id,
                recipients: recipients,
                subject:    'Inventory Adjustment Request Rejected: ' + (requestName || ('#' + rec.id)),
                body:       'The inventory adjustment request "' + (requestName || ('#' + rec.id)) +
                            '" has been rejected.<br><br>' +
                            'Please perform a cycle count for the affected items and submit a new ' +
                            'request if an adjustment is still required.<br><br>' +
                            'This is an automated notification.'
            });
            log.audit('Rejection email sent', 'Request ' + rec.id + ' -> recipients: ' + recipients.join(','));
        } catch (e) {
            log.error('sendRejectionEmail failed', e.message);
        }
    }

    // ------------------------------------------------------------------
    // getReasonAccount - read the mapped GL account off the adjustment
    // reason record (customrecord_atlas_inv_adj_reasn / field custrecord_atlas_glaccount)
    // ------------------------------------------------------------------
    function getReasonAccount(reasonId) {
        var accountId = null;
        var FIELD_ID = 'custrecord_atlas_glaccount';
        try {
            var reasonFields = search.lookupFields({
                type:    'customrecord_atlas_inv_adj_reasn',
                id:      reasonId,
                columns: [FIELD_ID]
            });
            var val = reasonFields[FIELD_ID];
            if (val && val.length > 0) {
                accountId = val[0].value;
            }
        } catch (e) {
            log.error('getReasonAccount failed', e.message + ' - check FIELD_ID matches the account field on the reason record');
        }
        return accountId;
    }

    // ------------------------------------------------------------------
    // getBinId - look up bin internal ID from bin name + location, for
    // the actual Inventory Adjustment creation (needs a real internal ID,
    // not just a validation pass/fail). Called once per line inside the
    // loop above - a deliberate per-line governance cost (bins are looked
    // up by name, not carried as IDs on the line record).
    // ------------------------------------------------------------------
    function getBinId(binName, locationId) {
        if (!binName) { return null; }
        try {
            var sql = 'SELECT id FROM bin WHERE binnumber = ? AND location = ? AND isinactive = \'F\'';
            var results = query.runSuiteQL({ query: sql, params: [binName, locationId] }).asMappedResults();
            return results.length > 0 ? results[0].id : null;
        } catch (e) {
            log.error('getBinId failed', 'Bin "' + binName + '" at location ' + locationId + ': ' + e.message);
            return null;
        }
    }

    return {
        beforeSubmit: beforeSubmit,
        afterSubmit:  afterSubmit
    };
});
