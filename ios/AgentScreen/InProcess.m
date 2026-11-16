#import "InProcess.h"
#import <CoreGraphics/CoreGraphics.h>
#import <dlfcn.h>
#import <objc/runtime.h>

@interface NSObject (ScreenPrivate)
+ (id)sharedSessionPromiseAndImplicitlyInitiateSession:(BOOL)initiate;
- (BOOL)promiseFulfilled;
- (NSError *)error;
- (id)value;
- (BOOL)enableAutomationModeWithError:(NSError **)error;
+ (id)localDevice;
- (void)_silentPressButton:(long long)button;
- (id)accessibilityInterface;
- (BOOL)loadAccessibility:(NSError **)error;
- (NSArray *)activeApplications;
- (int)processIdentifier;
- (NSDictionary *)defaultParameters;
- (id)accessibilityElement;
+ (id)scrollToVisibleAction;
- (BOOL)performAction:(id)action onElement:(id)element value:(id)value error:(NSError **)error;
- (BOOL)setAttribute:(id)attribute value:(id)value element:(id)element outError:(NSError **)error;
+ (id)axAttributesForElementSnapshotKeyPaths:(NSArray *)paths isMacOS:(BOOL)mac;
- (id)requestSnapshotForElement:(id)element attributes:(NSArray *)attributes parameters:(NSDictionary *)parameters error:(NSError **)error;
- (NSArray *)children;
- (long long)elementType;
- (CGRect)frame;
- (NSString *)label;
- (NSString *)identifier;
- (BOOL)isEnabled;
- (BOOL)isSelected;
- (BOOL)hasKeyboardFocus;
- (id)daemonProxy;
- (id)initForTouchAtPoint:(CGPoint)point offset:(double)offset;
- (void)moveToPoint:(CGPoint)point atOffset:(double)offset;
- (void)liftUpAtOffset:(double)offset;
- (id)initWithName:(NSString *)name interfaceOrientation:(long long)orientation;
- (void)addPointerEventPath:(id)path;
- (void)_XCT_synthesizeEvent:(id)event implicitConfirmationInterval:(double)interval completion:(void (^)(NSError *))completion;
- (void)_XCT_requestBundleIDForPID:(int)pid reply:(void (^)(NSString *, NSError *))reply;
- (void)_XCT_launchApplicationWithBundleID:(NSString *)bundle arguments:(NSArray *)arguments environment:(NSDictionary *)environment completion:(void (^)(NSError *))completion;
- (id)initForTextInput;
- (void)typeText:(NSString *)text atOffset:(double)offset typingSpeed:(NSUInteger)speed shouldRedact:(BOOL)redact;
- (id)initWithName:(NSString *)name;
+ (id)mainScreen;
- (id)screenshot;
- (NSData *)PNGRepresentation;
+ (id)defaultWorkspace;
- (NSArray *)allInstalledApplications;
- (NSString *)bundleIdentifier;
- (NSString *)localizedName;
@end

static NSDictionary *failure(NSString *reason, NSString *detail) {
    return @{ @"ok": @NO, @"reason": reason, @"detail": detail ?: @"" };
}

static NSDictionary *success(NSDictionary *value) {
    return @{ @"ok": @YES, @"value": value };
}

@interface InProcess ()
@property(nonatomic) dispatch_queue_t queue;
@property(nonatomic) id session;
@property(nonatomic) id accessibility;
@property(nonatomic) NSMutableArray *seen;
@property(nonatomic) BOOL timedOut;
@end

@implementation InProcess

- (instancetype)init {
    self = [super init];
    if (self) _queue = dispatch_queue_create("pi.screen.session", DISPATCH_QUEUE_SERIAL);
    return self;
}

- (void)request:(NSString *)operation arguments:(NSDictionary<NSString *, id> *)arguments completion:(void (^)(NSDictionary<NSString *, id> *))completion {
    NSObject *gate = [NSObject new];
    __block BOOL finished = NO;
    void (^finish)(NSDictionary *) = ^(NSDictionary *result) {
        @synchronized (gate) {
            if (finished) return;
            finished = YES;
        }
        dispatch_async(dispatch_get_main_queue(), ^{ completion(result); });
    };
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC), dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @synchronized (gate) {
            if (finished) return;
            @synchronized (self) { self.timedOut = YES; }
            finish(failure(@"session_timeout", @"Private API exceeded 15 seconds; reopen pi before retrying"));
        }
    });
    dispatch_async(self.queue, ^{
        BOOL expired;
        @synchronized (self) { expired = self.timedOut; }
        if (expired) { finish(failure(@"session_timeout", @"Reopen pi before retrying")); return; }
        @try {
            NSDictionary *ready = [self connect];
            if (![ready[@"ok"] boolValue]) { finish(ready); return; }
            @synchronized (self) { expired = self.timedOut; }
            if (expired) { finish(failure(@"session_timeout", @"Reopen pi before retrying")); return; }
            finish([self perform:operation arguments:arguments]);
        } @catch (NSException *exception) {
            finish(failure(@"private_api_exception", [NSString stringWithFormat:@"%@: %@", exception.name, exception.reason]));
        }
    });
}

- (NSDictionary *)connect {
    if (self.accessibility) return success(@{});
    NSArray *paths = @[@"/System/Developer/Library/PrivateFrameworks/XCTestSupport.framework/XCTestSupport",
                       @"/System/Developer/usr/lib/lib_TestingInterop.dylib",
                       @"/System/Developer/Library/PrivateFrameworks/XCTestCore.framework/XCTestCore",
                       @"/System/Developer/Library/Frameworks/XCUIAutomation.framework/XCUIAutomation"];
    for (NSString *path in paths) {
        if (![NSFileManager.defaultManager fileExistsAtPath:path]) return failure(@"ddi_missing", @"Mount the developer disk image from a computer after reboot, then reopen pi");
        if (!dlopen(path.UTF8String, RTLD_NOW | RTLD_GLOBAL)) return failure(@"framework_load_failed", [NSString stringWithUTF8String:dlerror()]);
    }
    Class client = NSClassFromString(@"XCAXClient_iOS");
    Method notification = client ? class_getInstanceMethod(client, NSSelectorFromString(@"handleAccessibilityNotification:fromElement:payload:")) : NULL;
    if (!notification) return failure(@"private_api_unavailable", @"Accessibility notification handler is unavailable");
    // why: app-hosted XCTest has no test case for notifications; raw arguments also prevent ARC retaining the scalar notification code as an object
    method_setImplementation(notification, imp_implementationWithBlock(^(__unused void *receiver, __unused void *name, __unused void *element, __unused void *payload) {}));
    Class runner = NSClassFromString(@"XCTRunnerDaemonSession");
    if (![runner respondsToSelector:@selector(sharedSessionPromiseAndImplicitlyInitiateSession:)]) return failure(@"private_api_unavailable", @"No runner session entry point");
    id promise = [runner sharedSessionPromiseAndImplicitlyInitiateSession:YES];
    for (int attempt = 0; attempt < 800 && ![promise promiseFulfilled]; attempt++) [NSThread sleepForTimeInterval:0.01];
    if (![promise promiseFulfilled]) return failure(@"session_unavailable", @"The automation daemon did not connect in 8 seconds");
    if ([promise error]) return failure(@"session_unavailable", [[promise error] localizedDescription]);
    id session = [promise value];
    NSError *error = nil;
    if (![session enableAutomationModeWithError:&error]) return failure(@"automation_denied", error.localizedDescription);
    id accessibility = [[NSClassFromString(@"XCUIDevice") localDevice] accessibilityInterface];
    if (![accessibility loadAccessibility:&error]) return failure(@"accessibility_unavailable", error.localizedDescription);
    self.session = session;
    self.accessibility = accessibility;
    return success(@{});
}

- (NSDictionary *)perform:(NSString *)operation arguments:(NSDictionary *)args {
    if ([operation isEqualToString:@"status"]) return success(@{ @"allowed": @YES });
    if ([operation isEqualToString:@"snapshot"]) return [self snapshot];
    if ([operation isEqualToString:@"screenshot"]) {
        NSData *png = [[[NSClassFromString(@"XCUIScreen") mainScreen] screenshot] PNGRepresentation];
        return png.length ? success(@{ @"png": [png base64EncodedStringWithOptions:0] }) : failure(@"screenshot_failed", @"No PNG returned");
    }
    if ([operation isEqualToString:@"home"]) {
        id device = [NSClassFromString(@"XCUIDevice") localDevice];
        if (![device respondsToSelector:@selector(_silentPressButton:)]) return failure(@"private_api_unavailable", @"No home button entry point");
        [device _silentPressButton:1];
        return success(@{});
    }
    if ([operation isEqualToString:@"open"]) return [self launch:args[@"app"]];
    if ([operation isEqualToString:@"type"]) return [self type:args[@"text"]];
    if ([operation isEqualToString:@"fill"]) return [self fill:[args[@"ref"] integerValue] text:args[@"text"]];
    if ([operation isEqualToString:@"reveal"]) return [self reveal:[args[@"ref"] integerValue]];
    if ([operation isEqualToString:@"touch"]) {
        CGPoint from = CGPointMake([args[@"x"] doubleValue], [args[@"y"] doubleValue]);
        double duration = [args[@"seconds"] doubleValue];
        id path = [[NSClassFromString(@"XCPointerEventPath") alloc] initForTouchAtPoint:from offset:0];
        if (args[@"to_x"]) [path moveToPoint:CGPointMake([args[@"to_x"] doubleValue], [args[@"to_y"] doubleValue]) atOffset:duration];
        [path liftUpAtOffset:duration + 0.05];
        id record = [[NSClassFromString(@"XCSynthesizedEventRecord") alloc] initWithName:@"pi touch" interfaceOrientation:[args[@"orientation"] longLongValue]];
        [record addPointerEventPath:path];
        return [self synthesize:record];
    }
    return failure(@"unsupported_action", operation);
}

- (NSDictionary *)synthesize:(id)record {
    if (!record) return failure(@"private_api_unavailable", @"No event record");
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block NSError *error = nil;
    [[self.session daemonProxy] _XCT_synthesizeEvent:record implicitConfirmationInterval:0 completion:^(NSError *problem) {
        error = problem;
        dispatch_semaphore_signal(done);
    }];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC))) return failure(@"event_timeout", @"No acknowledgement in 10 seconds; do not retry the action blindly");
    return error ? failure(@"event_failed", error.localizedDescription) : success(@{});
}

- (NSDictionary *)type:(NSString *)text {
    id path = [[NSClassFromString(@"XCPointerEventPath") alloc] initForTextInput];
    [path typeText:text atOffset:0 typingSpeed:60 shouldRedact:NO];
    id record = [[NSClassFromString(@"XCSynthesizedEventRecord") alloc] initWithName:@"pi type"];
    [record addPointerEventPath:path];
    return [self synthesize:record];
}

- (NSDictionary *)launch:(NSString *)wanted {
    NSString *bundle = nil;
    NSString *name = nil;
    NSArray *installed = [[NSClassFromString(@"LSApplicationWorkspace") defaultWorkspace] allInstalledApplications];
    for (id app in installed) {
        NSString *identifier = [app bundleIdentifier];
        NSString *label = [app localizedName];
        if ([identifier caseInsensitiveCompare:wanted] == NSOrderedSame || [label caseInsensitiveCompare:wanted] == NSOrderedSame) {
            bundle = identifier;
            name = label;
            break;
        }
    }
    if (!bundle && [wanted containsString:@"."]) bundle = wanted;
    if (!bundle.length && !installed.count) return failure(@"app_list_unavailable", @"iOS does not let pi look apps up by name here; open it by its bundle id, such as com.company.app");
    if (!bundle.length) return failure(@"app_not_found", wanted);
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block NSError *error = nil;
    [[self.session daemonProxy] _XCT_launchApplicationWithBundleID:bundle arguments:@[] environment:@{} completion:^(NSError *problem) {
        error = problem;
        dispatch_semaphore_signal(done);
    }];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC))) return failure(@"launch_timeout", bundle);
    return error ? failure(@"launch_failed", error.localizedDescription) : success(@{ @"name": name ?: bundle });
}

- (NSDictionary *)bundleOf:(int)pid {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block NSString *bundle = nil;
    __block NSError *error = nil;
    [[self.session daemonProxy] _XCT_requestBundleIDForPID:pid reply:^(NSString *identifier, NSError *problem) {
        bundle = identifier;
        error = problem;
        dispatch_semaphore_signal(done);
    }];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC))) return failure(@"front_app_timeout", @"No bundle identifier in 2 seconds");
    return bundle ? success(@{ @"bundle": bundle }) : failure(@"front_app_unavailable", error.localizedDescription);
}

- (NSDictionary *)snapshot {
    id front = nil;
    NSString *bundle = nil;
    for (id app in [self.accessibility activeApplications]) {
        NSDictionary *resolved = [self bundleOf:[app processIdentifier]];
        if (![resolved[@"ok"] boolValue]) return resolved;
        NSString *identifier = resolved[@"value"][@"bundle"];
        front = app;
        bundle = identifier;
        if (![identifier isEqualToString:NSBundle.mainBundle.bundleIdentifier]) break;
    }
    if (!front) return failure(@"front_app_unavailable", @"No active application");
    NSMutableDictionary *parameters = [[self.accessibility defaultParameters] mutableCopy] ?: [NSMutableDictionary new];
    parameters[@"maxDepth"] = @60;
    parameters[@"maxChildren"] = @400;
    parameters[@"maxArrayCount"] = @400;
    parameters[@"traverseFromParentsToChildren"] = @YES;
    NSArray *keys = @[@"elementType", @"label", @"identifier", @"value", @"frame", @"enabled", @"selected", @"hasKeyboardFocus"];
    id mapped = [NSClassFromString(@"XCElementSnapshot") axAttributesForElementSnapshotKeyPaths:keys isMacOS:NO];
    NSArray *attributes = [mapped isKindOfClass:NSSet.class] ? [mapped allObjects] : mapped;
    NSMutableArray *kept = [NSMutableArray new];
    // why: requesting AX children on iOS 27 stalls snapshots; the returned root still contains the traversed children
    for (id attribute in attributes) {
        for (NSString *suffix in @[@"ElementType", @"Label", @"Identifier", @"Value", @"Frame", @"Enabled", @"Selected", @"Focus"]) {
            if ([[attribute description] hasSuffix:suffix]) { [kept addObject:attribute]; break; }
        }
    }
    if (!kept.count) return failure(@"private_api_unavailable", @"No supported snapshot attributes");
    NSError *error = nil;
    id snapshot = [self.accessibility requestSnapshotForElement:front attributes:kept parameters:parameters error:&error];
    if (!snapshot) return failure(@"snapshot_failed", error.localizedDescription);
    id root = [snapshot valueForKey:@"_rootElementSnapshot"];
    if (!root) return failure(@"snapshot_failed", @"No root element snapshot");
    self.seen = [NSMutableArray new];
    return success(@{ @"package": bundle, @"app": [root label] ?: bundle, @"tree": [self node:root] });
}

- (NSDictionary *)node:(id)snapshot {
    CGRect frame = [snapshot frame];
    id value = [snapshot value];
    NSUInteger ref = self.seen.count;
    [self.seen addObject:[snapshot accessibilityElement] ?: NSNull.null];
    NSMutableArray *children = [NSMutableArray new];
    for (id child in [snapshot children]) [children addObject:[self node:child]];
    return @{ @"type": @([snapshot elementType]), @"label": [snapshot label] ?: @"", @"identifier": [snapshot identifier] ?: @"",
              @"value": [value isKindOfClass:NSString.class] ? value : [value respondsToSelector:@selector(stringValue)] ? [value stringValue] : @"",
              @"x": @(frame.origin.x), @"y": @(frame.origin.y), @"width": @(frame.size.width), @"height": @(frame.size.height),
              @"enabled": @([snapshot isEnabled]), @"selected": @([snapshot isSelected]),
              @"focused": @([snapshot respondsToSelector:@selector(hasKeyboardFocus)] && [snapshot hasKeyboardFocus]), @"ref": @(ref), @"children": children };
}

- (NSDictionary *)fill:(NSInteger)ref text:(NSString *)text {
    id element = ref >= 0 && ref < (NSInteger)self.seen.count ? self.seen[ref] : nil;
    if (!element || element == NSNull.null) return failure(@"fill_failed", @"The element is not in the last snapshot");
    id mapped = [NSClassFromString(@"XCElementSnapshot") axAttributesForElementSnapshotKeyPaths:@[@"value"] isMacOS:NO];
    id attribute = [([mapped isKindOfClass:NSSet.class] ? [mapped allObjects] : mapped) firstObject];
    if (!attribute || ![self.accessibility respondsToSelector:@selector(setAttribute:value:element:outError:)]) return failure(@"private_api_unavailable", @"No value attribute setter");
    NSError *error = nil;
    return [self.accessibility setAttribute:attribute value:text element:element outError:&error] ? success(@{}) : failure(@"fill_failed", error.localizedDescription);
}

- (NSDictionary *)reveal:(NSInteger)ref {
    id element = ref >= 0 && ref < (NSInteger)self.seen.count ? self.seen[ref] : nil;
    if (!element || element == NSNull.null) return failure(@"reveal_failed", @"The element is not in the last snapshot");
    id action = [NSClassFromString(@"XCUIAccessibilityAction") respondsToSelector:@selector(scrollToVisibleAction)] ? [NSClassFromString(@"XCUIAccessibilityAction") scrollToVisibleAction] : nil;
    if (!action || ![self.accessibility respondsToSelector:@selector(performAction:onElement:value:error:)]) return failure(@"private_api_unavailable", @"No scroll-to-visible action");
    NSError *error = nil;
    return [self.accessibility performAction:action onElement:element value:nil error:&error] ? success(@{}) : failure(@"reveal_failed", error.localizedDescription);
}

@end
