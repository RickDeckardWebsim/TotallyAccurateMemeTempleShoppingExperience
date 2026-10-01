// Probability settings for random events

export const CONFIG = {
    // Probabilities (as percentages)
    DROP_ITEM_CHANCE: 10,          // Chance to drop an item (10%)
    POWER_OUTAGE_CHANCE: 6,        // Chance of power outage (6%)
    OUT_OF_STOCK_CHANCE: 8,        // Chance an item on list is out of stock / missing (8%)
    SLIPPERY_FLOOR_CHANCE: 13,     // Chance of slipping on floor (13%)
    CART_STUCK_CHANCE: 8,          // Chance of cart wheel getting stuck
    STORE_CLOSING_CHANCE: 10,      // Chance of store closing in 1 minute (10%)
    TRIPPING_CHANCE: 0.01,         // Tripping chance (0.01%)
    CHECKOUT_BUTTON_REQUIRED_CHANCE: 0.10, // 10% chance for the checkout button to be required
    CHECKOUT_BUSY_CHANCE: 25,      // 25% chance a customer is busy at checkout
    GUM_CRAVING_CHANCE: 35,        // 35% chance of sudden gum craving while checking out
    POWERUP_CHANCE: 2,             // 2% chance per game
    FORGOT_GLASSES_CHANCE: 10,     // Chance per run and timed event reroll

    // RNG aspects probabilities
    SINGLE_ITEM_LIST_CHANCE: 3,    // 3% chance for single item list
    EMPTY_SHELF_CHANCE: 7,         // 7% chance per game that 1 shelf is empty
    TWO_IN_ONE_ITEM_CHANCE: 20,    // 20% chance for 2-in-1 item
    ADD_ITEM_CHANCE: 0.4,          // 0.4% chance per second to add item
    REMOVE_ITEM_CHANCE: 0.33,      // 0.33% chance per second to remove item

    // Probabilities
    CUSTOMER_QUESTION_CHANCE: 2.5, // 2.5% chance
    CUSTOMER_THEFT_CHANCE: 8,      // 8% chance per second while touching a customer
    NO_MONEY_CHANCE: 2,            // 2% chance
    THIEF_BREAK_IN_CHANCE: 6,      // 6% chance of thief break in
    PRODUCT_SPILL_CHANCE: 15,      // 15% chance of product spill
    BABY_CRYING_CHANCE: 5,         // 5% chance for baby crying
    BABY_IN_CART_CHANCE: 7,        // 7% chance per game to find a baby in the cart
    ENSURE_TWO_IN_ONE_ITEM: false, // Flag to ensure a 2-in-1 item always appears
    SHELF_COUNT: null,
    MIN_SHOPPING_LIST_ITEMS: null,
    MAX_SHOPPING_LIST_ITEMS: null,

    // Falling Shelf event defaults
    FALLING_SHELF_ENABLED: true,
    FALLING_SHELF_CHANCE: 5,       // 5% chance per game
    MISLABELED_ITEM_CHANCE: 0.015, // 1.5% probability per pickup
    WEIGHT_CHANGE_CHANCE: 0.015, // 1.5% probability per pickup

    // Under construction zone event (percent per game)
    UNDER_CONSTRUCTION_CHANCE: 15, // 15% chance per game

    // Manager jumpscare event (percent per game)
    MANAGER_JUMPSCARE_CHANCE: 8,   // 8% chance per game

    // Call from wife / text message event (percent per game)
    WIFE_CALL_CHANCE: 13,

    // Random earthquake event (percent per game)
    EARTHQUAKE_CHANCE: 8,
    THERMOSTAT_CHANCE: 7,         // Thermostat malfunction chance per event roll
    CUSTOMER_SCUFFLE_CHANCE: 13,  // Chance per timed event roll; starts during a customer conversation
    TWEAKER_CHANCE: 8,           // Chance per timed event roll
    NUCLEAR_FALLOUT_CHANCE: 1,   // Rarest event: rolled once per run, never rerolled

    // Lonely Store whole-run modifier (percent per game)
    LONELY_STORE_CHANCE: 1,

    // Side quest rolls; null means use the vanilla range each run
    RETURN_ITEM_COUNT: null,        // 1-3
    RETURN_THROW_DISTANCE: null,    // 1.4-2.8 m back from the Info Desk, re-rolled per item
    RESTROOM_DURATION: null,        // 4-14 seconds
    RESTROOM_TARGETS: null,         // 3-6
    SPARE_CHANGE_CHANCE: 10,
    CHANGE_GIVEN_CHANCE: 50,
    MORE_SAMPLES_CHANCE: 50,
    CAR_TROUBLE_CHANCE: 50,

    // 4% RNG chance per shelf to replace a shelf with a Freezer Unit
    SHELF_REPLACE_CHANCE: 4
};

export let PROBABILITIES = { 
    ITEM_ADDED_EVENT_COUNT: 0,
    ITEM_REMOVED_EVENT_COUNT: 0,
    TWO_IN_ONE_ITEM_COLLECTED: false,
    THIEF: null,
    IS_CUSTOM_GAME: false,
    NO_MONEY_CHANCE: 2,            // 1/50 chance (2%)
    ARE_CONTROLS_LOCKED: false,
    ...CONFIG 
};

export function resetProbabilities() {
    PROBABILITIES = { 
        ITEM_ADDED_EVENT_COUNT: 0,
        ITEM_REMOVED_EVENT_COUNT: 0,
        TWO_IN_ONE_ITEM_COLLECTED: false,
        THIEF: null,
        IS_CUSTOM_GAME: false,
        NO_MONEY_CHANCE: 2,            // 1/50 chance (2%)
        ARE_CONTROLS_LOCKED: false,
        ...CONFIG 
    };
}

// Customization settings
let isCustomGame = false;

function showCustomizationMenu() {
    // Display customization menu
}

function hideCustomizationMenu() {
    // Hide customization menu
}

function hideMainMenu() {
    // Hide main menu
}

function startGame() {
    // Start the game
}

// Function to save and start custom game
function saveAndStartCustomGame() {
    // Save all customized values
    CONFIG.SHELF_COUNT = parseInt(document.getElementById('shelf-count').value);
    CONFIG.MIN_SHOPPING_LIST_ITEMS = parseInt(document.getElementById('item-count').value);
    CONFIG.MAX_SHOPPING_LIST_ITEMS = parseInt(document.getElementById('item-count').value);
    CONFIG.POWER_OUTAGE_CHANCE = parseFloat(document.getElementById('power-outage').value);
    CONFIG.SLIPPERY_FLOOR_CHANCE = parseFloat(document.getElementById('slippery-floor').value);
    CONFIG.STORE_CLOSING_CHANCE = parseFloat(document.getElementById('store-closing').value);
    CONFIG.THIEF_BREAK_IN_CHANCE = parseFloat(document.getElementById('thief-chance').value);
    CONFIG.TWO_IN_ONE_ITEM_CHANCE = parseFloat(document.getElementById('two-in-one').value);
    CONFIG.EMPTY_SHELF_CHANCE = parseFloat(document.getElementById('empty-shelf').value);
    CONFIG.TRIPPING_CHANCE = parseFloat(document.getElementById('trip-chance').value);

    // Save no money chance
    CONFIG.NO_MONEY_CHANCE = parseFloat(document.getElementById('no-money').value);
    // Save customer theft chance
    CONFIG.CUSTOMER_THEFT_CHANCE = parseFloat(document.getElementById('customer-theft-chance').value);

    CONFIG.PRODUCT_SPILL_CHANCE = parseFloat(document.getElementById('product-spill').value);
    
    // Save checkout button chance
    CONFIG.CHECKOUT_BUTTON_REQUIRED_CHANCE = parseFloat(document.getElementById('checkout-button').value) / 100;

    // Save item add and remove chances
    CONFIG.ADD_ITEM_CHANCE = parseFloat(document.getElementById('item-add-chance').value);
    CONFIG.REMOVE_ITEM_CHANCE = parseFloat(document.getElementById('item-remove-chance').value);

    // Save baby crying chance
    CONFIG.BABY_CRYING_CHANCE = parseFloat(document.getElementById('baby-crying-chance').value);

    // Save Powerup chance
    if (document.getElementById('powerup-chance')) {
        CONFIG.POWERUP_CHANCE = parseFloat(document.getElementById('powerup-chance').value);
    }

    // Save Falling Shelf customization
    CONFIG.FALLING_SHELF_CHANCE = parseFloat(document.getElementById('falling-shelf-chance').value);
    CONFIG.FALLING_SHELF_ENABLED = (CONFIG.FALLING_SHELF_CHANCE ?? 0) > 0;

    // NEW: Under construction zone chance
    CONFIG.UNDER_CONSTRUCTION_CHANCE = parseFloat(document.getElementById('under-construction-chance').value);

    // NEW: Manager jumpscare chance
    CONFIG.MANAGER_JUMPSCARE_CHANCE = parseFloat(document.getElementById('manager-jumpscare').value);

    // NEW: Wife call chance
    if (document.getElementById('wife-call-chance')) {
        CONFIG.WIFE_CALL_CHANCE = parseFloat(document.getElementById('wife-call-chance').value);
    }

    // NEW: Earthquake chance
    if (document.getElementById('earthquake-chance')) {
        CONFIG.EARTHQUAKE_CHANCE = parseFloat(document.getElementById('earthquake-chance').value);
    }
    if (document.getElementById('thermostat-chance')) {
        CONFIG.THERMOSTAT_CHANCE = parseFloat(document.getElementById('thermostat-chance').value);
    }
    if (document.getElementById('customer-scuffle-chance')) {
        CONFIG.CUSTOMER_SCUFFLE_CHANCE = parseFloat(document.getElementById('customer-scuffle-chance').value);
    }
    if (document.getElementById('tweaker-chance')) {
        CONFIG.TWEAKER_CHANCE = parseFloat(document.getElementById('tweaker-chance').value);
    }

    // NEW: Lonely store whole-run modifier chance
    CONFIG.LONELY_STORE_CHANCE = parseFloat(document.getElementById('lonely-store-chance').value);

    // NEW: Shelf replacement / freezer chance (4% default)
    if (document.getElementById('shelf-replace-chance')) {
        CONFIG.SHELF_REPLACE_CHANCE = parseFloat(document.getElementById('shelf-replace-chance').value);
    }

    isCustomGame = true;
    hideCustomizationMenu();
    hideMainMenu();
    startGame();
}
