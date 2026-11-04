// Showcase sample — real path: test/repositories/escalation_repository_test.dart.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:late_payment_escalator/repositories/escalation_repository.dart';

class MockSupabaseClient extends Mock implements SupabaseClient {}

class MockSupabaseQueryBuilder extends Mock implements SupabaseQueryBuilder {}

class MockPostgrestFilterBuilder extends Mock
    implements PostgrestFilterBuilder<PostgrestList> {}

/// A stubbed [PostgrestFilterBuilder] that resolves immediately with
/// [_value] when awaited, instead of performing a real HTTP request. Same
/// technique used in client_repository_test.dart and invoice_repository_test.dart.
class _StubPostgrestFilterBuilder<T> extends Mock
    implements PostgrestFilterBuilder<T> {
  _StubPostgrestFilterBuilder(this._value);

  final T _value;

  @override
  Future<U> then<U>(
    FutureOr<U> Function(T value) onValue, {
    Function? onError,
  }) {
    return Future<T>.value(_value).then(onValue, onError: onError);
  }
}

void main() {
  late MockSupabaseClient mockClient;
  late EscalationRepository repository;

  setUp(() {
    mockClient = MockSupabaseClient();
    repository = EscalationRepository(client: mockClient);
  });

  test('listStages() returns stages parsed from the escalation_stages table, sorted by stage number', () async {
    final mockQueryBuilder = MockSupabaseQueryBuilder();
    final filterBuilder = MockPostgrestFilterBuilder();
    when(() => mockClient.from('escalation_stages'))
        .thenAnswer((_) => mockQueryBuilder);
    when(() => mockQueryBuilder.select()).thenAnswer((_) => filterBuilder);
    when(() => filterBuilder.eq('invoice_id', 'i1')).thenAnswer(
      (_) => _StubPostgrestFilterBuilder<List<Map<String, dynamic>>>([
        {
          'id': 'e2',
          'invoice_id': 'i1',
          'stage_number': 2,
          'sent_at': null,
          'send_state': 'failed',
          'created_at': '2026-08-05T00:00:00.000Z',
        },
        {
          'id': 'e1',
          'invoice_id': 'i1',
          'stage_number': 1,
          'sent_at': '2026-08-01T00:00:00.000Z',
          'send_state': 'sent',
          'created_at': '2026-08-01T00:00:00.000Z',
        },
      ]),
    );

    final stages = await repository.listStages('i1');

    expect(stages.map((s) => s.stageNumber), [1, 2]);
  });

  test('pause() calls the pause_invoice RPC with the invoice id', () async {
    when(() => mockClient.rpc('pause_invoice', params: {'p_invoice_id': 'i1'}))
        .thenAnswer((_) => _StubPostgrestFilterBuilder<dynamic>(null));

    await repository.pause('i1');

    verify(() => mockClient.rpc('pause_invoice', params: {'p_invoice_id': 'i1'}))
        .called(1);
  });

  test('resume() calls the resume_invoice RPC with the invoice id', () async {
    when(() => mockClient.rpc('resume_invoice', params: {'p_invoice_id': 'i1'}))
        .thenAnswer((_) => _StubPostgrestFilterBuilder<dynamic>(null));

    await repository.resume('i1');

    verify(() => mockClient.rpc('resume_invoice', params: {'p_invoice_id': 'i1'}))
        .called(1);
  });

  test('listClicks() returns clicks parsed from invoice_link_clicks, sorted newest first', () async {
    final mockQueryBuilder = MockSupabaseQueryBuilder();
    final filterBuilder = MockPostgrestFilterBuilder();
    when(() => mockClient.from('invoice_link_clicks'))
        .thenAnswer((_) => mockQueryBuilder);
    when(() => mockQueryBuilder.select()).thenAnswer((_) => filterBuilder);
    when(() => filterBuilder.eq('invoice_id', 'i1')).thenAnswer(
      (_) => _StubPostgrestFilterBuilder<List<Map<String, dynamic>>>([
        {
          'id': 'c1',
          'invoice_id': 'i1',
          'escalation_stage_id': null,
          'clicked_at': '2026-08-01T00:00:00.000Z',
          'created_at': '2026-08-01T00:00:00.000Z',
        },
        {
          'id': 'c2',
          'invoice_id': 'i1',
          'escalation_stage_id': 'e1',
          'clicked_at': '2026-08-05T00:00:00.000Z',
          'created_at': '2026-08-05T00:00:00.000Z',
        },
      ]),
    );

    final clicks = await repository.listClicks('i1');

    expect(clicks.map((c) => c.id), ['c2', 'c1']);
  });

  test('hasUnresolvedStopRequest() returns false when the invoice has no stop-request snapshot rows', () async {
    final linksQueryBuilder = MockSupabaseQueryBuilder();
    final linksFilterBuilder = MockPostgrestFilterBuilder();
    when(() => mockClient.from('stop_request_invoices'))
        .thenAnswer((_) => linksQueryBuilder);
    when(() => linksQueryBuilder.select('stop_request_id'))
        .thenAnswer((_) => linksFilterBuilder);
    when(() => linksFilterBuilder.eq('invoice_id', 'i1')).thenAnswer(
      (_) => _StubPostgrestFilterBuilder<List<Map<String, dynamic>>>([]),
    );

    final result = await repository.hasUnresolvedStopRequest('i1');

    expect(result, isFalse);
  });

  test('hasUnresolvedStopRequest() returns true when a snapshotted stop_requests row is unhandled', () async {
    final linksQueryBuilder = MockSupabaseQueryBuilder();
    final linksFilterBuilder = MockPostgrestFilterBuilder();
    when(() => mockClient.from('stop_request_invoices'))
        .thenAnswer((_) => linksQueryBuilder);
    when(() => linksQueryBuilder.select('stop_request_id'))
        .thenAnswer((_) => linksFilterBuilder);
    when(() => linksFilterBuilder.eq('invoice_id', 'i1')).thenAnswer(
      (_) => _StubPostgrestFilterBuilder<List<Map<String, dynamic>>>([
        {'stop_request_id': 'sr1'},
      ]),
    );

    final requestsQueryBuilder = MockSupabaseQueryBuilder();
    final requestsFilterBuilder = MockPostgrestFilterBuilder();
    when(() => mockClient.from('stop_requests'))
        .thenAnswer((_) => requestsQueryBuilder);
    when(() => requestsQueryBuilder.select('id'))
        .thenAnswer((_) => requestsFilterBuilder);
    when(() => requestsFilterBuilder.inFilter('id', ['sr1']))
        .thenAnswer((_) => requestsFilterBuilder);
    when(() => requestsFilterBuilder.isFilter('handled_at', null)).thenAnswer(
      (_) => _StubPostgrestFilterBuilder<List<Map<String, dynamic>>>([
        {'id': 'sr1'},
      ]),
    );

    final result = await repository.hasUnresolvedStopRequest('i1');

    expect(result, isTrue);
  });
}
